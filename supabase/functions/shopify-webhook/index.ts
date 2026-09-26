// Recebe webhooks orders/create do Shopify.
// Responsabilidades: verificar HMAC, deduplicar, persistir e avisar o n8n.
// Persistir antes de chamar qualquer serviço externo garante que nenhum pedido
// se perde se o n8n ou a IA estiverem fora (o sweep do n8n recupera pendentes).

import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyShopifyHmac } from "../_shared/hmac.ts";
import { checkPersonalisation, type ProductRule } from "../_shared/checks.ts";
import { extractPersonalisation, isShopifyOrder } from "../_shared/shopify.ts";

const SHOPIFY_SECRET = Deno.env.get("SHOPIFY_WEBHOOK_SECRET") ?? "";
const N8N_REVIEW_URL = Deno.env.get("N8N_REVIEW_WEBHOOK_URL") ?? "";
const N8N_SECRET = Deno.env.get("N8N_WEBHOOK_SECRET") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const rawBody = await req.text();
  const ok = await verifyShopifyHmac(rawBody, req.headers.get("x-shopify-hmac-sha256"), SHOPIFY_SECRET);
  if (!ok) return json(401, { error: "invalid_hmac" });

  const topic = req.headers.get("x-shopify-topic") ?? "";
  const shopDomain = (req.headers.get("x-shopify-shop-domain") ?? "").toLowerCase();
  const webhookId = req.headers.get("x-shopify-webhook-id") ?? "";
  if (!webhookId || !shopDomain) return json(400, { error: "missing_headers" });

  // Idempotência: o Shopify reenvia o mesmo webhook_id em caso de timeout.
  const { data: seen } = await supabase
    .from("webhook_events").select("webhook_id").eq("webhook_id", webhookId).maybeSingle();
  if (seen) return json(200, { status: "duplicate" });

  if (topic !== "orders/create") {
    await recordEvent(webhookId, topic, shopDomain);
    return json(200, { status: "ignored_topic" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (!isShopifyOrder(payload)) return json(400, { error: "invalid_order_payload" });
  const order = payload;

  const { data: brand } = await supabase
    .from("brands").select("id").eq("shop_domain", shopDomain).maybeSingle();
  if (!brand) {
    // 200 para o Shopify não reenviar indefinidamente uma loja desconhecida
    await recordEvent(webhookId, topic, shopDomain);
    return json(200, { status: "unknown_shop" });
  }

  const personalised = order.line_items
    .map((li) => ({ li, fields: extractPersonalisation(li) }))
    .filter((x) => Object.keys(x.fields).length > 0);

  if (personalised.length === 0) {
    await recordEvent(webhookId, topic, shopDomain);
    return json(200, { status: "no_personalisation" });
  }

  const skus = personalised.map((x) => x.li.sku).filter((s): s is string => !!s);
  const { data: rules } = await supabase
    .from("product_rules").select("sku, max_chars, charset")
    .eq("brand_id", brand.id).in("sku", skus.length ? skus : ["__none__"]);
  const ruleBySku = new Map((rules ?? []).map((r) => [r.sku, r as ProductRule]));

  // Pedido: insere se não existir (reentregas não resetam o status)
  const { error: upErr } = await supabase.from("orders").upsert({
    brand_id: brand.id,
    shopify_order_id: order.id,
    order_number: order.name,
    customer_first_name: order.customer?.first_name ?? null,
    currency: order.currency,
    total_price: Number(order.total_price),
    raw: order,
  }, { onConflict: "brand_id,shopify_order_id", ignoreDuplicates: true });
  if (upErr) return json(500, { error: "db_error", detail: upErr.message });

  const { data: saved, error: selErr } = await supabase
    .from("orders").select("id, status")
    .eq("brand_id", brand.id).eq("shopify_order_id", order.id).single();
  if (selErr || !saved) return json(500, { error: "db_error", detail: selErr?.message });

  const items = personalised.map(({ li, fields }) => ({
    order_id: saved.id,
    shopify_line_item_id: li.id,
    sku: li.sku,
    title: li.title,
    quantity: li.quantity,
    personalisation: fields,
    checks: checkPersonalisation(fields, li.sku ? ruleBySku.get(li.sku) ?? null : null),
  }));
  const { error: itErr } = await supabase
    .from("order_items").upsert(items, { onConflict: "order_id,shopify_line_item_id", ignoreDuplicates: true });
  if (itErr) return json(500, { error: "db_error", detail: itErr.message });

  await recordEvent(webhookId, topic, shopDomain);

  // Aviso ao n8n fora do caminho crítico: o Shopify exige resposta em < 5 s.
  if (saved.status === "pending" && N8N_REVIEW_URL) {
    const notify = fetch(N8N_REVIEW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-secret": N8N_SECRET },
      body: JSON.stringify({ order_id: saved.id }),
    }).catch((e) => console.warn("n8n notify failed; sweep will retry", e?.message));
    // deno-lint-ignore no-explicit-any
    (globalThis as any).EdgeRuntime?.waitUntil?.(notify);
  }

  return json(200, { status: "accepted", order_id: saved.id, items: items.length });
});

async function recordEvent(webhookId: string, topic: string, shopDomain: string) {
  await supabase.from("webhook_events")
    .upsert({ webhook_id: webhookId, topic, shop_domain: shopDomain }, { ignoreDuplicates: true });
}
