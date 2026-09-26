-- Marcas de demonstração (lojas de desenvolvimento simuladas)
insert into public.brands (id, name, shop_domain, auto_approve_min_confidence) values
  ('11111111-1111-4111-8111-111111111111', 'Engrave & Co', 'engrave-co.myshopify.com', 0.85),
  ('22222222-2222-4222-8222-222222222222', 'Little Stitch', 'little-stitch.myshopify.com', 0.90)
on conflict (id) do nothing;

-- Limites por produto
insert into public.product_rules (brand_id, sku, max_chars, charset) values
  ('11111111-1111-4111-8111-111111111111', 'ENG-KEYRING', 20, 'engraving'),
  ('11111111-1111-4111-8111-111111111111', 'ENG-WATCH',   40, 'engraving'),
  ('11111111-1111-4111-8111-111111111111', 'PRT-FAMILY',  60, 'print'),
  ('22222222-2222-4222-8222-222222222222', 'EMB-BABYGROW', 12, 'embroidery'),
  ('22222222-2222-4222-8222-222222222222', 'EMB-BLANKET',  24, 'embroidery')
on conflict do nothing;
