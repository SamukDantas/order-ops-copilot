-- Personalização como lista ordenada [{name, value}].
-- Um objeto jsonb não guarda a ordem das chaves (o Postgres ordena por tamanho
-- e depois por bytes: "Line 10" vinha antes de "Line 2"). Numa gravação, a ordem
-- das linhas é parte do pedido.
--
-- Converte as linhas existentes sem mudar nenhum valor: os pares vêm do objeto
-- atual e só a ORDEM é recuperada, pela posição do campo nas properties do
-- payload original (orders.raw); na falta, pela lista de verificações
-- determinísticas (checks.fields, gravada na ordem de chegada); por último, pelo
-- nome.

update public.order_items i
set personalisation = coalesce((
  select jsonb_agg(jsonb_build_object('name', e.key, 'value', e.value)
                   order by coalesce(pos_raw.ord, pos_checks.ord + 100000, 200000), e.key)
  from jsonb_each_text(i.personalisation) e
  left join lateral (
    select min(p.ord) as ord
    from public.orders o
    cross join lateral jsonb_array_elements(coalesce(o.raw -> 'line_items', '[]'::jsonb)) li
    cross join lateral jsonb_array_elements(coalesce(li -> 'properties', '[]'::jsonb)) with ordinality as p(prop, ord)
    where o.id = i.order_id
      and li ->> 'id' = i.shopify_line_item_id::text
      and p.prop ->> 'name' = e.key
  ) pos_raw on true
  left join lateral (
    select min(f.ord) as ord
    from jsonb_array_elements(coalesce(i.checks -> 'fields', '[]'::jsonb)) with ordinality as f(campo, ord)
    where f.campo ->> 'name' = e.key
  ) pos_checks on true
), '[]'::jsonb)
where jsonb_typeof(i.personalisation) = 'object';

alter table public.order_items
  alter column personalisation set default '[]'::jsonb,
  add constraint order_items_personalisation_lista
    check (jsonb_typeof(personalisation) = 'array');

comment on column public.order_items.personalisation is
  'Lista [{name, value}] na ordem das properties do line item no Shopify (sem as internas, com "_").';
