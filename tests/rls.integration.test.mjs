// Teste de integração do RLS contra o Supabase LOCAL.
// Pré-requisitos: `supabase start`, `node scripts/seed-usuarios.mjs` e pedidos
// das duas marcas (`npm run simular -- all`).
//
// Uso: node --test tests/

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { DEMO_PASSWORD } from "../scripts/demo-config.mjs";

const ENGRAVE = "11111111-1111-4111-8111-111111111111";
const STITCH = "22222222-2222-4222-8222-222222222222";
let url, pub, secret;

before(() => {
  const s = JSON.parse(execSync("npx -y supabase@latest status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString());
  url = s.API_URL; pub = s.PUBLISHABLE_KEY; secret = s.SECRET_KEY;
});

async function login(email) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: pub, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: DEMO_PASSWORD }),
  });
  const body = await res.json();
  assert.ok(res.ok, JSON.stringify(body));
  return (path, init = {}) => fetch(`${url}/rest/v1/${path}`, {
    ...init, headers: { apikey: pub, Authorization: `Bearer ${body.access_token}`, "Content-Type": "application/json", ...init.headers },
  });
}

const admin = (path, init = {}) => fetch(`${url}/rest/v1/${path}`, {
  ...init, headers: { apikey: secret, Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...init.headers },
});

/** Garante uma revisão aguardando decisão na marca indicada e devolve o id. */
async function pendingReview(brandId) {
  const rows = await (await admin(`orders?brand_id=eq.${brandId}&select=id,status,order_items(id,reviews(id))&limit=1&order=created_at`)).json();
  assert.ok(rows.length, `sem pedidos da marca ${brandId}: rode npm run simular -- all`);
  const order = rows[0];
  const itemId = order.order_items[0].id;
  // coloca o pedido em revisão com uma revisão de teste (via service role)
  await admin(`orders?id=eq.${order.id}`, { method: "PATCH", body: JSON.stringify({ status: "reviewing" }) });
  const r = await admin("rpc/save_review_results", { method: "POST", body: JSON.stringify({
    p_order_id: order.id, p_order_status: "needs_review",
    p_results: order.order_items.map((i) => ({ order_item_id: i.id, verdict: "fix", issues: ["teste"], suggested_text: null,
      customer_message: null, confidence: 0.5, model: "test", prompt_version: "test", latency_ms: 1 })),
  }) });
  assert.equal(r.status, 204, await r.text());
  const reviews = await (await admin(`reviews?order_item_id=eq.${itemId}&select=id&order=created_at.desc&limit=1`)).json();
  return { orderId: order.id, reviewId: reviews[0].id };
}

test("revisor só enxerga pedidos da própria marca", async () => {
  const db = await login("reviewer@demo.test");
  const orders = await (await db("orders?select=brand_id")).json();
  assert.ok(orders.length > 0);
  assert.ok(orders.every((o) => o.brand_id === ENGRAVE));
  const brands = await (await db("brands?select=id")).json();
  assert.deepEqual(brands.map((b) => b.id), [ENGRAVE]);
});

test("admin das duas marcas enxerga as duas", async () => {
  const db = await login("ops@demo.test");
  const ids = new Set((await (await db("orders?select=brand_id")).json()).map((o) => o.brand_id));
  assert.ok(ids.has(ENGRAVE) && ids.has(STITCH));
});

test("usuário não acessa tabelas internas nem funções do workflow", async () => {
  const db = await login("ops@demo.test");
  assert.deepEqual(await (await db("workflow_errors?select=id")).json(), []);
  assert.deepEqual(await (await db("webhook_events?select=webhook_id")).json(), []);
  const claim = await db("rpc/claim_orders_for_review", { method: "POST", body: "{}" });
  assert.ok([401, 403].includes(claim.status), await claim.text());
});

test("usuário não altera pedidos diretamente", async () => {
  const db = await login("ops@demo.test");
  const res = await db(`orders?brand_id=eq.${ENGRAVE}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "approved" }) });
  const rows = res.ok ? await res.json() : [];
  assert.equal(rows.length, 0, "UPDATE não deveria afetar linhas");
});

test("viewer não pode decidir; revisor de outra marca também não", async () => {
  const { reviewId } = await pendingReview(STITCH);
  const viewer = await login("viewer@demo.test");
  const r1 = await viewer("rpc/decide_review", { method: "POST", body: JSON.stringify({ p_review_id: reviewId, p_action: "approve" }) });
  assert.ok(!r1.ok);
  assert.match(await r1.text(), /sem permissão/);

  const reviewer = await login("reviewer@demo.test");
  const r2 = await reviewer("rpc/decide_review", { method: "POST", body: JSON.stringify({ p_review_id: reviewId, p_action: "approve" }) });
  assert.ok(!r2.ok);
});

test("revisor decide na própria marca e o pedido é fechado", async () => {
  const { orderId, reviewId } = await pendingReview(ENGRAVE);
  const db = await login("reviewer@demo.test");
  const items = await (await admin(`order_items?order_id=eq.${orderId}&select=id`)).json();
  let status;
  for (const [i] of items.entries()) {
    const rid = i === 0 ? reviewId : (await (await admin(`reviews?order_item_id=eq.${items[i].id}&select=id&order=created_at.desc&limit=1`)).json())[0].id;
    const res = await db("rpc/decide_review", { method: "POST", body: JSON.stringify({
      p_review_id: rid, p_action: "edit", p_final_text: [{ name: "Engraving", value: "Corrigido" }], p_note: "teste",
    }) });
    const body = await res.text();
    assert.ok(res.ok, body);
    status = JSON.parse(body);
  }
  assert.equal(status, "approved");
  // decidir de novo é recusado
  const again = await db("rpc/decide_review", { method: "POST", body: JSON.stringify({ p_review_id: reviewId, p_action: "approve" }) });
  assert.ok(!again.ok);
});

test("decisão humana também respeita as regras duras do produto", async () => {
  // #1043 (Little Stitch): "Baby Olivia 💕" tem 13 caracteres para limite 12 e emoji
  const rows = await (await admin(`orders?order_number=eq.%231043&select=id`)).json();
  assert.ok(rows.length, "rode npm run simular -- all");
  const { reviewId } = await pendingReview(STITCH);
  const db = await login("ops@demo.test");
  const call = (body) => db("rpc/decide_review", { method: "POST", body: JSON.stringify({ p_review_id: reviewId, ...body }) });

  const asTyped = await call({ p_action: "approve" });
  assert.ok(!asTyped.ok);
  assert.match(await asTyped.text(), /viola as regras/);

  const tooLong = await call({ p_action: "edit", p_final_text: [{ name: "Name", value: "Baby Olivia xx" }] });
  assert.ok(!tooLong.ok);
  assert.match(await tooLong.text(), /excede o limite de 12/);

  const ok = await call({ p_action: "edit", p_final_text: [{ name: "Name", value: "Baby Olivia" }] });
  assert.ok(ok.ok, await ok.text());
});
