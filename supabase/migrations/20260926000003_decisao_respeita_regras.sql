-- Regras duras valem também para decisões humanas:
--  • "approve" (como digitado) é recusado se as verificações determinísticas falharam;
--  • "edit" é recusado se algum campo exceder o limite de caracteres do produto.

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
  v_checks jsonb;
  v_max int;
  v_too_long text;
  v_pending int;
  v_rejected int;
begin
  select o.id, o.brand_id, o.status, i.checks, pr.max_chars
  into v_order_id, v_brand_id, v_status, v_checks, v_max
  from public.reviews r
  join public.order_items i on i.id = r.order_item_id
  join public.orders o on o.id = i.order_id
  left join public.product_rules pr on pr.brand_id = o.brand_id and pr.sku = i.sku
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
  if p_action = 'approve' and coalesce((v_checks->>'passed')::boolean, true) = false then
    raise exception 'o texto viola as regras do produto; edite antes de aprovar' using errcode = '22023';
  end if;
  if p_action = 'edit' then
    if p_final_text is null or jsonb_typeof(p_final_text) <> 'array' then
      raise exception 'edição exige final_text como lista de {name, value}' using errcode = '22023';
    end if;
    if v_max is not null then
      select f->>'name' into v_too_long
      from jsonb_array_elements(p_final_text) f
      where char_length(f->>'value') > v_max
      limit 1;
      if v_too_long is not null then
        raise exception 'campo "%" excede o limite de % caracteres', v_too_long, v_max using errcode = '22023';
      end if;
    end if;
  end if;

  insert into public.review_decisions (review_id, decided_by, action, final_text, note)
  values (p_review_id, (select auth.uid()), p_action, p_final_text, p_note);

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
