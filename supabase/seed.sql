-- Marcas de demonstração (lojas de desenvolvimento simuladas)
insert into public.brands (id, name, shop_domain, auto_approve_min_confidence) values
  ('11111111-1111-4111-8111-111111111111', 'Engrave & Co', 'engrave-co.myshopify.com', 0.85),
  ('22222222-2222-4222-8222-222222222222', 'Little Stitch', 'little-stitch.myshopify.com', 0.90),
  ('33333333-3333-4333-8333-333333333333', 'Order Ops Demo Store', 'order-ops-copilot-demo.myshopify.com', 0.85)
on conflict (id) do nothing;

-- Limites por produto
insert into public.product_rules (brand_id, sku, max_chars, charset) values
  ('11111111-1111-4111-8111-111111111111', 'ENG-KEYRING', 20, 'engraving'),
  ('11111111-1111-4111-8111-111111111111', 'ENG-WATCH',   40, 'engraving'),
  ('11111111-1111-4111-8111-111111111111', 'PRT-FAMILY',  60, 'print'),
  ('22222222-2222-4222-8222-222222222222', 'EMB-BABYGROW', 12, 'embroidery'),
  ('22222222-2222-4222-8222-222222222222', 'EMB-BLANKET',  24, 'embroidery'),
  -- Loja de desenvolvimento real: mesmos SKUs das fixtures (npm run shopify -- pedido)
  ('33333333-3333-4333-8333-333333333333', 'ENG-KEYRING', 20, 'engraving'),
  ('33333333-3333-4333-8333-333333333333', 'ENG-WATCH',   40, 'engraving'),
  ('33333333-3333-4333-8333-333333333333', 'PRT-FAMILY',  60, 'print'),
  ('33333333-3333-4333-8333-333333333333', 'EMB-BABYGROW', 12, 'embroidery'),
  ('33333333-3333-4333-8333-333333333333', 'EMB-BLANKET',  24, 'embroidery')
on conflict do nothing;
