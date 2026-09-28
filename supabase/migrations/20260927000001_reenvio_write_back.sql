-- Reenvio do write-back no Shopify.
-- Uma decisão (automática ou humana) pode não chegar ao Shopify: o n8n estava
-- fora do ar quando o painel chamou o webhook, ou a Admin API falhou. A decisão
-- já está gravada; esta função lista os pedidos decididos sem write-back
-- bem-sucedido depois da decisão, e a varredura do n8n os reaplica.

create or replace function public.orders_pending_sync(
  p_limit        int      default 20,
  p_max_failures int      default 5,                     -- desiste depois de N falhas registradas
  p_older_than   interval default interval '2 minutes',  -- não disputa com o envio imediato
  p_max_age      interval default interval '30 days'
)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('order_id', p.id) order by p.status_changed_at), '[]'::jsonb)
  from (
    select o.id, o.status_changed_at
    from public.orders o
    where o.status in ('auto_approved', 'approved', 'rejected')
      and o.status_changed_at < now() - p_older_than
      and o.status_changed_at > now() - p_max_age
      -- só conta o que aconteceu depois da decisão atual
      and not exists (
        select 1 from public.shopify_sync_log s
        where s.order_id = o.id and s.ok and s.created_at >= o.status_changed_at)
      and (select count(*) from public.shopify_sync_log s
           where s.order_id = o.id and not s.ok and s.created_at >= o.status_changed_at) < p_max_failures
    order by o.status_changed_at
    limit p_limit
  ) p;
$$;

revoke execute on function public.orders_pending_sync(int, int, interval, interval) from public, anon, authenticated;
grant execute on function public.orders_pending_sync(int, int, interval, interval) to service_role;
