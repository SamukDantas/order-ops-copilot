#!/usr/bin/env node
// Exporta os pedidos de exemplo (#1041–#1048) já revisados pela IA no banco
// LOCAL para supabase/demo/demo-data.sql, que carrega a demo online.
//
// Só entram revisões feitas por um modelo de verdade (as dos testes de
// integração ficam de fora), e o status de cada pedido é recalculado com a
// mesma lógica de roteamento do workflow. Decisões humanas não são exportadas:
// na demo, todo pedido sinalizado começa aguardando revisão.
//
// Uso: node scripts/exportar-demo.ts

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { routeItem, routeOrder } from "../lib/review-logic.ts";
import type { Field, ModelVerdict, ReviewRoute } from "../lib/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NUMEROS = ["#1041", "#1042", "#1043", "#1044", "#1045", "#1046", "#1048"];

interface Status { API_URL: string; SECRET_KEY: string }
interface ReviewRow {
  id: string; verdict: ModelVerdict | "unavailable"; issues: string[]; suggested_text: Field[] | null;
  customer_message: string | null; confidence: number; deterministic_checks: unknown; model: string;
  prompt_version: string; latency_ms: number | null; created_at: string;
}
interface ItemRow {
  id: string; shopify_line_item_id: number; sku: string | null; title: string; quantity: number;
  personalisation: Record<string, string>; checks: { passed?: boolean }; reviews: ReviewRow[];
}
interface OrderRow {
  id: string; brand_id: string; shopify_order_id: number; order_number: string; customer_first_name: string | null;
  currency: string | null; total_price: number | null; raw: unknown; created_at: string;
  brands: { auto_approve_min_confidence: number }; order_items: ItemRow[];
}

const status = JSON.parse(execSync("npx -y supabase@latest status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString()) as Status;
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(status.API_URL)) throw new Error("exporta apenas do Supabase local");

const filtro = encodeURIComponent(`(${NUMEROS.map((n) => `"${n}"`).join(",")})`);
const res = await fetch(
  `${status.API_URL}/rest/v1/orders?order_number=in.${filtro}&select=*,brands(auto_approve_min_confidence),order_items(*,reviews(*))&order=order_number`,
  { headers: { apikey: status.SECRET_KEY, Authorization: `Bearer ${status.SECRET_KEY}` } },
);
if (!res.ok) throw new Error(`REST ${res.status}: ${await res.text()}`);
const orders = (await res.json()) as OrderRow[];

// ─── SQL ─────────────────────────────────────────────────────────────
const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return `array[${v.map((x) => lit(x)).join(", ")}]::text[]`;
  }
  if (typeof v === "object") return `${lit(JSON.stringify(v))}::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const emptyTextArray = (v: string[]): string => (v.length ? lit(v) : "'{}'::text[]");

const linhas: string[] = [];
let exportados = 0;
for (const o of orders) {
  const itens: { item: ItemRow; review: ReviewRow; rota: ReviewRoute }[] = [];
  for (const item of o.order_items) {
    const review = [...item.reviews]
      .filter((r) => r.model !== "test")
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!review) continue;
    const parsed = review.verdict === "unavailable"
      ? { ok: false as const, reason: "unavailable" }
      : { ok: true as const, model: review.model, review: {
          verdict: review.verdict, issues: review.issues, suggested_text: review.suggested_text,
          confidence: Number(review.confidence), customer_message: review.customer_message } };
    const rota = routeItem({ parsed, checksPassed: item.checks?.passed === true, brandThreshold: Number(o.brands.auto_approve_min_confidence) });
    itens.push({ item, review, rota });
  }
  if (itens.length !== o.order_items.length) {
    console.warn(`! ${o.order_number} ignorado: item sem revisão da IA`);
    continue;
  }
  const statusPedido = routeOrder(itens.map((i) => i.rota));
  exportados++;

  linhas.push(`-- ${o.order_number} → ${statusPedido}`);
  linhas.push(`insert into public.orders (id, brand_id, shopify_order_id, order_number, customer_first_name, currency, total_price, status, raw, created_at) values (${[
    o.id, o.brand_id, o.shopify_order_id, o.order_number, o.customer_first_name, o.currency, o.total_price,
  ].map(lit).join(", ")}, ${lit(statusPedido)}::public.order_status, ${lit(o.raw)}, ${lit(o.created_at)});`);
  for (const { item, review } of itens) {
    linhas.push(`insert into public.order_items (id, order_id, shopify_line_item_id, sku, title, quantity, personalisation, checks) values (${[
      item.id, o.id, item.shopify_line_item_id, item.sku, item.title, item.quantity, item.personalisation, item.checks,
    ].map(lit).join(", ")});`);
    linhas.push(`insert into public.reviews (id, order_item_id, verdict, issues, suggested_text, customer_message, confidence, deterministic_checks, model, prompt_version, latency_ms, created_at) values (${[
      review.id, item.id,
    ].map(lit).join(", ")}, ${lit(review.verdict)}::public.review_verdict, ${emptyTextArray(review.issues)}, ${[
      review.suggested_text, review.customer_message, Number(review.confidence), review.deterministic_checks,
      review.model, review.prompt_version, review.latency_ms, review.created_at,
    ].map(lit).join(", ")});`);
  }
  linhas.push("");
}

const sql = `-- Dados da demo online: gerado por scripts/exportar-demo.ts. Não edite à mão.
-- Idempotente: apaga os pedidos das marcas de demonstração (e, em cascata,
-- itens, revisões, decisões e sync) e recarrega o estado inicial.
-- Aplicar: node scripts/carregar-demo.ts

begin;

insert into public.brands (id, name, shop_domain, auto_approve_min_confidence) values
  ('11111111-1111-4111-8111-111111111111', 'Engrave & Co', 'engrave-co.myshopify.com', 0.85),
  ('22222222-2222-4222-8222-222222222222', 'Little Stitch', 'little-stitch.myshopify.com', 0.90)
on conflict (id) do nothing;

insert into public.product_rules (brand_id, sku, max_chars, charset) values
  ('11111111-1111-4111-8111-111111111111', 'ENG-KEYRING', 20, 'engraving'),
  ('11111111-1111-4111-8111-111111111111', 'ENG-WATCH',   40, 'engraving'),
  ('11111111-1111-4111-8111-111111111111', 'PRT-FAMILY',  60, 'print'),
  ('22222222-2222-4222-8222-222222222222', 'EMB-BABYGROW', 12, 'embroidery'),
  ('22222222-2222-4222-8222-222222222222', 'EMB-BLANKET',  24, 'embroidery')
on conflict do nothing;

delete from public.orders where brand_id in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');

${linhas.join("\n")}
commit;
`;

const out = join(root, "supabase", "demo", "demo-data.sql");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, sql);
console.log(`✓ ${exportados} pedidos exportados para supabase/demo/demo-data.sql`);
