-- Métricas operacionais por marca, para o painel (/metrics).
-- SECURITY INVOKER: roda com o usuário logado, então o RLS das tabelas se
-- aplica e cada pessoa só vê as marcas das quais é membro.
--
-- Tempos (segundos), por pedido:
--   revisão = primeira revisão da IA − pedido recebido (webhook persistido)
--   decisão = última decisão humana − última revisão da IA (a que o humano julgou)
-- Metas do TDD (§3): p95 da revisão < 60 s e menos de 20% dos pedidos com humano.

create or replace function public.brand_metrics(p_days int default 30)
returns table (
  brand_id        uuid,
  brand_name      text,
  orders_reviewed int,      -- já passaram pela IA (qualquer status final ou needs_review)
  auto_approved   int,
  needs_human     int,      -- needs_review, approved ou rejected
  ai_unavailable  int,      -- pedidos com algum item em que a IA falhou
  review_p50_s    numeric,
  review_p95_s    numeric,
  decision_p50_s  numeric,
  decision_p95_s  numeric,
  sync_pending    int       -- decididos sem write-back bem-sucedido desde a decisão
)
language sql stable security invoker set search_path = ''
as $$
  with pedidos as (
    select
      o.id, o.brand_id, o.status, o.created_at, o.status_changed_at,
      (select min(r.created_at) from public.order_items i
         join public.reviews r on r.order_item_id = i.id
        where i.order_id = o.id) as primeira_revisao,
      (select max(r.created_at) from public.order_items i
         join public.reviews r on r.order_item_id = i.id
        where i.order_id = o.id) as ultima_revisao,
      (select max(d.created_at) from public.order_items i
         join public.reviews r on r.order_item_id = i.id
         join public.review_decisions d on d.review_id = r.id
        where i.order_id = o.id) as decidido_em,
      exists (select 1 from public.order_items i
                join public.reviews r on r.order_item_id = i.id
               where i.order_id = o.id and r.verdict = 'unavailable') as ia_indisponivel,
      exists (select 1 from public.shopify_sync_log s
               where s.order_id = o.id and s.ok and s.created_at >= o.status_changed_at) as sincronizado
    from public.orders o
    where p_days is null or o.created_at >= now() - make_interval(days => p_days)
  ),
  tempos as (
    select *,
      extract(epoch from primeira_revisao - created_at) as revisao_s,
      extract(epoch from decidido_em - ultima_revisao) as decisao_s
    from pedidos
  )
  select
    b.id,
    b.name,
    count(*) filter (where t.status in ('auto_approved', 'needs_review', 'approved', 'rejected'))::int,
    count(*) filter (where t.status = 'auto_approved')::int,
    count(*) filter (where t.status in ('needs_review', 'approved', 'rejected'))::int,
    count(*) filter (where t.ia_indisponivel)::int,
    round((percentile_cont(0.5)  within group (order by t.revisao_s))::numeric, 1),
    round((percentile_cont(0.95) within group (order by t.revisao_s))::numeric, 1),
    round((percentile_cont(0.5)  within group (order by t.decisao_s))::numeric, 1),
    round((percentile_cont(0.95) within group (order by t.decisao_s))::numeric, 1),
    count(*) filter (where t.status in ('auto_approved', 'approved', 'rejected') and not t.sincronizado)::int
  from public.brands b
  left join tempos t on t.brand_id = b.id
  group by b.id, b.name
  order by b.name;
$$;

revoke execute on function public.brand_metrics(int) from public, anon;
grant execute on function public.brand_metrics(int) to authenticated, service_role;
