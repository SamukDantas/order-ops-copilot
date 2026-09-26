-- Funções chamadas pelo n8n (service_role) e pelo dashboard (authenticated).
-- Cada uma é uma transação: nada fica pela metade se o workflow cair no meio.

-- ─── Log de write-back no Shopify (modo mock e real) ─────────────────
create table public.shopify_sync_log (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  mode       text not null check (mode in ('mock', 'live')),
  tags       text[] not null default '{}',
  note       text,
  ok         boolean not null,
  response   jsonb,
  created_at timestamptz not null default now()
);
create index shopify_sync_log_order_idx on public.shopify_sync_log(order_id, created_at desc);
alter table public.shopify_sync_log enable row level security;
create policy "membro ve sync da marca" on public.shopify_sync_log
  for select to authenticated using (
    exists (select 1 from public.orders o where o.id = order_id and public.is_brand_member(o.brand_id))
  );

-- ─── Claim atômico ───────────────────────────────────────────────────
-- Marca como 'reviewing' e devolve o contexto completo para revisão.
-- Retorna vazio se outro worker já pegou o pedido (FOR UPDATE SKIP LOCKED).
create or replace function public.claim_orders_for_review(
  p_order_id uuid default null,
  p_pending_older_than interval default interval '2 minutes',
  p_reviewing_older_than interval default interval '10 minutes',
  p_limit int default 20
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  select array_agg(id) into v_ids from (
    select o.id from public.orders o
    where (p_order_id is not null and o.id = p_order_id and o.status = 'pending')
       or (p_order_id is null and (
             (o.status = 'pending'   and o.status_changed_at < now() - p_pending_older_than) or
             (o.status = 'reviewing' and o.status_changed_at < now() - p_reviewing_older_than)))
    order by o.created_at
    limit p_limit
    for update skip locked
  ) t;

  if v_ids is null then
    return '[]'::jsonb;
  end if;

  update public.orders set status = 'reviewing' where id = any(v_ids);

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'order_id', o.id,
      'order_number', o.order_number,
      'order_date', to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD'),
      'brand_threshold', b.auto_approve_min_confidence,
      'items', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'order_item_id', i.id,
          'title', i.title,
          'sku', i.sku,
          'charset', r.charset,
          'personalisation', i.personalisation,
          'checks', i.checks
        ) order by i.shopify_line_item_id), '[]'::jsonb)
        from public.order_items i
        left join public.product_rules r on r.brand_id = o.brand_id and r.sku = i.sku
        where i.order_id = o.id
      )
    ) order by o.created_at), '[]'::jsonb)
    from public.orders o join public.brands b on b.id = o.brand_id
    where o.id = any(v_ids)
  );
end;
$$;

-- ─── Grava revisões + status do pedido numa transação ────────────────
-- p_results: [{order_item_id, verdict, issues, suggested_text, customer_message,
--              confidence, model, prompt_version, latency_ms, failure_reason}]
create or replace function public.save_review_results(
  p_order_id uuid,
  p_order_status public.order_status,
  p_results jsonb
)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_order_status not in ('auto_approved', 'needs_review', 'error') then
    raise exception 'status inválido para revisão: %', p_order_status;
  end if;

  insert into public.reviews (
    order_item_id, verdict, issues, suggested_text, customer_message,
    confidence, deterministic_checks, model, prompt_version, latency_ms
  )
  select
    (r->>'order_item_id')::uuid,
    (r->>'verdict')::public.review_verdict,
    coalesce(array(select jsonb_array_elements_text(r->'issues')), '{}'),
    nullif(r->'suggested_text', 'null'::jsonb),
    r->>'customer_message',
    (r->>'confidence')::numeric,
    coalesce(i.checks, '{}'::jsonb),
    r->>'model',
    r->>'prompt_version',
    (r->>'latency_ms')::int
  from jsonb_array_elements(p_results) r
  join public.order_items i on i.id = (r->>'order_item_id')::uuid and i.order_id = p_order_id;

  update public.orders set status = p_order_status
  where id = p_order_id and status = 'reviewing';
end;
$$;

-- ─── Decisão humana (dashboard) ──────────────────────────────────────
-- Registra a decisão de um item e, quando todos os itens do pedido tiverem
-- decisão, fecha o pedido. Retorna o novo status do pedido.
create or replace function public.decide_review(
  p_review_id uuid,
  p_action public.decision_action,
  p_final_text jsonb default null,
  p_note text default null
)
returns public.order_status
language plpgsql security definer set search_path = ''
as $$
declare
  v_order_id uuid;
  v_brand_id uuid;
  v_status public.order_status;
  v_pending int;
  v_rejected int;
begin
  select o.id, o.brand_id, o.status into v_order_id, v_brand_id, v_status
  from public.reviews r
  join public.order_items i on i.id = r.order_item_id
  join public.orders o on o.id = i.order_id
  where r.id = p_review_id
  for update of o;

  if v_order_id is null then
    raise exception 'revisão não encontrada' using errcode = 'P0002';
  end if;
  if not public.is_brand_member(v_brand_id, 'reviewer') then
    raise exception 'sem permissão para decidir nesta marca' using errcode = '42501';
  end if;
  if v_status <> 'needs_review' then
    raise exception 'pedido não está aguardando revisão (status: %)', v_status using errcode = 'P0001';
  end if;
  if p_action = 'edit' and (p_final_text is null or jsonb_typeof(p_final_text) <> 'array') then
    raise exception 'edição exige final_text como lista de {name, value}' using errcode = '22023';
  end if;

  insert into public.review_decisions (review_id, decided_by, action, final_text, note)
  values (p_review_id, (select auth.uid()), p_action, p_final_text, p_note);

  -- itens cuja revisão mais recente ainda não tem decisão
  select count(*) filter (where d.id is null), count(*) filter (where d.action = 'reject')
  into v_pending, v_rejected
  from public.order_items i
  cross join lateral (
    select r.id from public.reviews r where r.order_item_id = i.id order by r.created_at desc limit 1
  ) lr
  left join lateral (
    select d.id, d.action from public.review_decisions d where d.review_id = lr.id
    order by d.created_at desc limit 1
  ) d on true
  where i.order_id = v_order_id;

  if v_pending = 0 then
    update public.orders
    set status = case when v_rejected > 0 then 'rejected' else 'approved' end::public.order_status
    where id = v_order_id
    returning status into v_status;
  end if;

  return v_status;
end;
$$;

-- Permissões: funções de workflow só para service_role; decisão para authenticated.
revoke execute on function public.claim_orders_for_review(uuid, interval, interval, int) from public, anon, authenticated;
revoke execute on function public.save_review_results(uuid, public.order_status, jsonb) from public, anon, authenticated;
grant execute on function public.claim_orders_for_review(uuid, interval, interval, int) to service_role;
grant execute on function public.save_review_results(uuid, public.order_status, jsonb) to service_role;
revoke execute on function public.decide_review(uuid, public.decision_action, jsonb, text) from public, anon;
grant execute on function public.decide_review(uuid, public.decision_action, jsonb, text) to authenticated;
