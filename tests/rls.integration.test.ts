// Teste de integração do RLS contra o Supabase LOCAL.
// Pré-requisitos: `supabase start`, `node scripts/seed-usuarios.ts` e pedidos
// das duas marcas (`npm run simular -- all`).
//
// Uso: npm run test:integration

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { DEMO_PASSWORD } from "../scripts/demo-config.ts";

const ENGRAVE = "11111111-1111-4111-8111-111111111111";
const STITCH = "22222222-2222-4222-8222-222222222222";

interface SupabaseStatus { API_URL: string; PUBLISHABLE_KEY: string; SECRET_KEY: string }
type Rest = (path: string, init?: RequestInit) => Promise<Response>;

interface OrderRow { id: string; status: string; brand_id: string; order_items: { id: string; reviews: { id: string }[] }[] }

let url = "";
let pub = "";
let secret = "";

before(() => {
  const s = JSON.parse(execSync("npx -y supabase@latest status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString()) as SupabaseStatus;
  url = s.API_URL; pub = s.PUBLISHABLE_KEY; secret = s.SECRET_KEY;
});

const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;

const rest = (apikey: string, bearer: string): Rest => (path, init = {}) => fetch(`${url}/rest/v1/${path}`, {
  ...init,
  headers: { apikey, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
});

async function login(email: string): Promise<Rest> {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: pub, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: DEMO_PASSWORD }),
  });
  const body = (await res.json()) as { access_token?: string };
  assert.ok(res.ok && body.access_token, JSON.stringify(body));
  return rest(pub, body.access_token);
}

const admin: Rest = (path, init) => rest(secret, secret)(path, init);

/** Garante uma revisão aguardando decisão na marca indicada e devolve o id. */
async function pendingReview(brandId: string): Promise<{ orderId: string; reviewId: string }> {
  const rows = await json<OrderRow[]>(admin(`orders?brand_id=eq.${brandId}&select=id,status,order_items(id,reviews(id))&limit=1&order=created_at`));
  const order = rows[0];
  assert.ok(order, `sem pedidos da marca ${brandId}: rode npm run simular -- all`);
  const itemId = order.order_items[0]?.id;
  assert.ok(itemId);
  // coloca o pedido em revisão com uma revisão de teste (via service role)
  await admin(`orders?id=eq.${order.id}`, { method: "PATCH", body: JSON.stringify({ status: "reviewing" }) });
  const r = await admin("rpc/save_review_results", { method: "POST", body: JSON.stringify({
    p_order_id: order.id, p_order_status: "needs_review",
    p_results: order.order_items.map((i) => ({ order_item_id: i.id, verdict: "fix", issues: ["teste"], suggested_text: null,
      customer_message: null, confidence: 0.5, model: "test", prompt_version: "test", latency_ms: 1 })),
  }) });
  assert.equal(r.status, 204, await r.text());
  const reviews = await json<{ id: string }[]>(admin(`reviews?order_item_id=eq.${itemId}&select=id&order=created_at.desc&limit=1`));
  assert.ok(reviews[0]);
  return { orderId: order.id, reviewId: reviews[0].id };
}

test("revisor só enxerga pedidos da própria marca", async () => {
  const db = await login("reviewer@demo.test");
  const orders = await json<{ brand_id: string }[]>(db("orders?select=brand_id"));
  assert.ok(orders.length > 0);
  assert.ok(orders.every((o) => o.brand_id === ENGRAVE));
  const brands = await json<{ id: string }[]>(db("brands?select=id"));
  assert.deepEqual(brands.map((b) => b.id), [ENGRAVE]);
});

test("admin das duas marcas enxerga as duas", async () => {
  const db = await login("ops@demo.test");
  const ids = new Set((await json<{ brand_id: string }[]>(db("orders?select=brand_id"))).map((o) => o.brand_id));
  assert.ok(ids.has(ENGRAVE) && ids.has(STITCH));
});

test("usuário não acessa tabelas internas nem funções do workflow", async () => {
  const db = await login("ops@demo.test");
  assert.deepEqual(await json<unknown[]>(db("workflow_errors?select=id")), []);
  assert.deepEqual(await json<unknown[]>(db("webhook_events?select=webhook_id")), []);
  const claim = await db("rpc/claim_orders_for_review", { method: "POST", body: "{}" });
  assert.ok([401, 403].includes(claim.status), await claim.text());
});

test("usuário não altera pedidos diretamente", async () => {
  const db = await login("ops@demo.test");
  const res = await db(`orders?brand_id=eq.${ENGRAVE}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "approved" }) });
  const rows = res.ok ? await json<unknown[]>(res) : [];
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
  const items = await json<{ id: string }[]>(admin(`order_items?order_id=eq.${orderId}&select=id`));
  let status: unknown;
  for (const [i, item] of items.entries()) {
    const rid = i === 0
      ? reviewId
      : (await json<{ id: string }[]>(admin(`reviews?order_item_id=eq.${item.id}&select=id&order=created_at.desc&limit=1`)))[0]?.id;
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
  const rows = await json<unknown[]>(admin(`orders?order_number=eq.%231043&select=id`));
  assert.ok(rows.length, "rode npm run simular -- all");
  const { reviewId } = await pendingReview(STITCH);
  const db = await login("ops@demo.test");
  const call = (body: Record<string, unknown>) =>
    db("rpc/decide_review", { method: "POST", body: JSON.stringify({ p_review_id: reviewId, ...body }) });

  const asTyped = await call({ p_action: "approve" });
  assert.ok(!asTyped.ok);
  assert.match(await asTyped.text(), /viola as regras/);

  const tooLong = await call({ p_action: "edit", p_final_text: [{ name: "Name", value: "Baby Olivia xx" }] });
  assert.ok(!tooLong.ok);
  assert.match(await tooLong.text(), /excede o limite de 12/);

  const ok = await call({ p_action: "edit", p_final_text: [{ name: "Name", value: "Baby Olivia" }] });
  assert.ok(ok.ok, await ok.text());
});
