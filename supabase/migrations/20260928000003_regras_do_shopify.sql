-- Regras por produto vindas do Shopify (metafields order_ops.max_chars e
-- order_ops.charset). O n8n lê os metafields da loja e sincroniza aqui; a Edge
-- Function continua lendo só o Postgres, então o webhook não depende da Admin
-- API estar no ar.

alter table public.product_rules
  add column source    text not null default 'manual' check (source in ('manual', 'shopify')),
  add column synced_at timestamptz;

comment on column public.product_rules.source is
  'manual: cadastrada no banco; shopify: sincronizada dos metafields da loja (sync_product_rules)';

-- Aplica as regras lidas da loja: insere/atualiza as recebidas (uma regra da
-- loja substitui a manual do mesmo SKU) e remove as de origem shopify que
-- sumiram da loja. Regras manuais de outros SKUs não são tocadas.
-- p_rules: [{sku, max_chars, charset}]
create or replace function public.sync_product_rules(p_shop_domain text, p_rules jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_brand   uuid;
  v_upserts int;
  v_removed int;
begin
  select id into v_brand from public.brands where shop_domain = lower(p_shop_domain);
  if v_brand is null then
    raise exception 'loja desconhecida: %', p_shop_domain using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_rules) <> 'array' then
    raise exception 'p_rules deve ser uma lista' using errcode = '22023';
  end if;

  with recebidas as (
    select r ->> 'sku' as sku, (r ->> 'max_chars')::int as max_chars, r ->> 'charset' as charset
    from jsonb_array_elements(p_rules) r
  ), gravadas as (
    insert into public.product_rules (brand_id, sku, max_chars, charset, source, synced_at)
    select v_brand, sku, max_chars, charset, 'shopify', now() from recebidas
    on conflict (brand_id, sku) do update
      set max_chars = excluded.max_chars, charset = excluded.charset,
          source = 'shopify', synced_at = excluded.synced_at
    returning 1
  )
  select count(*) into v_upserts from gravadas;

  with removidas as (
    delete from public.product_rules pr
    where pr.brand_id = v_brand and pr.source = 'shopify'
      and pr.sku not in (select r ->> 'sku' from jsonb_array_elements(p_rules) r)
    returning 1
  )
  select count(*) into v_removed from removidas;

  return jsonb_build_object('brand_id', v_brand, 'upserted', v_upserts, 'removed', v_removed);
end;
$$;

revoke execute on function public.sync_product_rules(text, jsonb) from public, anon, authenticated;
grant execute on function public.sync_product_rules(text, jsonb) to service_role;
