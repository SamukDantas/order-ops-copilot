-- Order Ops Copilot: schema inicial
-- Multi-marca: todo dado operacional pertence a uma marca, e o acesso
-- de usuários é controlado por brand_members via RLS.

create extension if not exists pgcrypto;

-- ─── Tipos ───────────────────────────────────────────────────────────
create type public.member_role as enum ('viewer', 'reviewer', 'admin');
create type public.order_status as enum (
  'pending', 'reviewing', 'auto_approved', 'needs_review', 'approved', 'rejected', 'error'
);
-- 'unavailable': a IA falhou (recusa, timeout, saída inválida) e o item vai para revisão manual
create type public.review_verdict as enum ('ok', 'fix', 'reject', 'unavailable');
create type public.decision_action as enum ('approve', 'edit', 'reject');

-- ─── Marcas e membros ────────────────────────────────────────────────
create table public.brands (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  shop_domain text not null unique,          -- ex: jonnys-sister.myshopify.com
  auto_approve_min_confidence numeric(3,2) not null default 0.85
    check (auto_approve_min_confidence between 0 and 1),
  created_at  timestamptz not null default now()
);

create table public.brand_members (
  brand_id   uuid not null references public.brands(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       public.member_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (brand_id, user_id)
);
create index brand_members_user_idx on public.brand_members(user_id);

-- ─── Pedidos ─────────────────────────────────────────────────────────
create table public.orders (
  id                 uuid primary key default gen_random_uuid(),
  brand_id           uuid not null references public.brands(id) on delete cascade,
  shopify_order_id   bigint not null,
  order_number       text not null,          -- ex: #1042
  customer_first_name text,
  currency           text,
  total_price        numeric(12,2),
  status             public.order_status not null default 'pending',
  status_changed_at  timestamptz not null default now(),
  raw                jsonb not null,         -- payload original do webhook
  created_at         timestamptz not null default now(),
  unique (brand_id, shopify_order_id)
);
create index orders_brand_status_idx on public.orders(brand_id, status);
create index orders_pending_idx on public.orders(status_changed_at) where status in ('pending', 'reviewing');

create table public.order_items (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references public.orders(id) on delete cascade,
  shopify_line_item_id  bigint not null,
  sku                   text,
  title                 text not null,
  quantity              int not null default 1,
  personalisation       jsonb not null default '{}'::jsonb,  -- properties do line item
  checks                jsonb not null default '{}'::jsonb,  -- verificações determinísticas na ingestão
  unique (order_id, shopify_line_item_id)
);
create index order_items_order_idx on public.order_items(order_id);

-- Regras por produto (v1: mapa por SKU; v2: metafields do Shopify)
create table public.product_rules (
  brand_id   uuid not null references public.brands(id) on delete cascade,
  sku        text not null,
  max_chars  int not null check (max_chars > 0),
  charset    text not null default 'engraving'  -- 'engraving' | 'print' | 'embroidery'
    check (charset in ('engraving', 'print', 'embroidery')),
  primary key (brand_id, sku)
);

-- ─── Revisões da IA e decisões humanas ───────────────────────────────
create table public.reviews (
  id               uuid primary key default gen_random_uuid(),
  order_item_id    uuid not null references public.order_items(id) on delete cascade,
  verdict          public.review_verdict not null,
  issues           text[] not null default '{}',
  suggested_text   jsonb,                    -- [{name, value}] quando verdict = 'fix'
  customer_message text,
  confidence       numeric(3,2) not null check (confidence between 0 and 1),
  deterministic_checks jsonb not null default '{}'::jsonb,
  model            text not null,
  prompt_version   text not null,
  latency_ms       int,
  created_at       timestamptz not null default now()
);
create index reviews_item_idx on public.reviews(order_item_id, created_at desc);

create table public.review_decisions (
  id          uuid primary key default gen_random_uuid(),
  review_id   uuid not null references public.reviews(id) on delete cascade,
  decided_by  uuid not null references auth.users(id),
  action      public.decision_action not null,
  final_text  jsonb,                        -- [{name, value}] aprovado pelo revisor
  note        text,
  created_at  timestamptz not null default now(),
  check (action <> 'edit' or final_text is not null)
);
create index review_decisions_review_idx on public.review_decisions(review_id);

-- ─── Infra: idempotência e erros (apenas service_role) ───────────────
create table public.webhook_events (
  webhook_id  text primary key,               -- X-Shopify-Webhook-Id
  topic       text not null,
  shop_domain text not null,
  received_at timestamptz not null default now()
);

create table public.workflow_errors (
  id          uuid primary key default gen_random_uuid(),
  workflow    text not null,
  node        text,
  order_id    uuid references public.orders(id) on delete set null,
  message     text not null,
  details     jsonb,
  execution_url text,
  created_at  timestamptz not null default now()
);
create index workflow_errors_created_idx on public.workflow_errors(created_at desc);

-- ─── Helpers de autorização ─────────────────────────────────────────
-- security definer + search_path fixo: evita recursão de RLS em brand_members
create or replace function public.is_brand_member(p_brand_id uuid, p_min_role public.member_role default 'viewer')
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.brand_members m
    where m.brand_id = p_brand_id
      and m.user_id = (select auth.uid())
      and m.role >= p_min_role
  );
$$;
revoke execute on function public.is_brand_member(uuid, public.member_role) from public, anon;
grant execute on function public.is_brand_member(uuid, public.member_role) to authenticated;

-- Mantém status_changed_at coerente (usado pelo sweep de pendentes)
create or replace function public.touch_status_changed_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;
create trigger orders_touch_status before update on public.orders
  for each row execute function public.touch_status_changed_at();

-- ─── RLS ─────────────────────────────────────────────────────────────
alter table public.brands           enable row level security;
alter table public.brand_members    enable row level security;
alter table public.orders           enable row level security;
alter table public.order_items      enable row level security;
alter table public.reviews          enable row level security;
alter table public.review_decisions enable row level security;
alter table public.product_rules    enable row level security;
alter table public.webhook_events   enable row level security;  -- sem policies: só service_role
alter table public.workflow_errors  enable row level security;  -- sem policies: só service_role

create policy "membro ve a marca" on public.brands
  for select to authenticated using (public.is_brand_member(id));

create policy "membro ve regras da marca" on public.product_rules
  for select to authenticated using (public.is_brand_member(brand_id));

create policy "usuario ve os proprios vinculos" on public.brand_members
  for select to authenticated using (user_id = (select auth.uid()));

create policy "membro ve pedidos da marca" on public.orders
  for select to authenticated using (public.is_brand_member(brand_id));

create policy "membro ve itens da marca" on public.order_items
  for select to authenticated using (
    exists (select 1 from public.orders o where o.id = order_id and public.is_brand_member(o.brand_id))
  );

create policy "membro ve revisoes da marca" on public.reviews
  for select to authenticated using (
    exists (
      select 1 from public.order_items i join public.orders o on o.id = i.order_id
      where i.id = order_item_id and public.is_brand_member(o.brand_id)
    )
  );

create policy "membro ve decisoes da marca" on public.review_decisions
  for select to authenticated using (
    exists (
      select 1 from public.reviews r
      join public.order_items i on i.id = r.order_item_id
      join public.orders o on o.id = i.order_id
      where r.id = review_id and public.is_brand_member(o.brand_id)
    )
  );

create policy "revisor registra decisao" on public.review_decisions
  for insert to authenticated with check (
    decided_by = (select auth.uid())
    and exists (
      select 1 from public.reviews r
      join public.order_items i on i.id = r.order_item_id
      join public.orders o on o.id = i.order_id
      where r.id = review_id and public.is_brand_member(o.brand_id, 'reviewer')
    )
  );

-- Anon não acessa nada
revoke all on all tables in schema public from anon;
