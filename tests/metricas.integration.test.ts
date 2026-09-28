// Teste de integração das métricas por marca (brand_metrics) contra o Supabase
// LOCAL. Cria uma marca isolada com tempos conhecidos, confere os números e os
// percentis, e que o RLS esconde a marca de quem não é membro.
// Pré-requisitos: `supabase start` e `node scripts/seed-usuarios.ts`.
//
// Uso: npm run test:integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { DEMO_PASSWORD } from "../scripts/demo-config.ts";

interface SupabaseStatus { API_URL: string; PUBLISHABLE_KEY: string; SECRET_KEY: string }
interface Metricas {
  brand_id: string; brand_name: string; orders_reviewed: number; auto_approved: number; needs_human: number;
  ai_unavailable: number; review_p50_s: number | null; review_p95_s: number | null;
  decision_p50_s: number | null; decision_p95_s: number | null; sync_pending: number;
}

const MARCA = "44444444-4444-4444-8444-444444444444";
let url = "";
let pub = "";
let secret = "";

const admin = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers as Record<string, string> | undefined) },
  });
  assert.ok(res.ok, `${path}: ${res.status} ${await res.clone().text()}`);
  return res;
};

async function login(email: string): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: pub, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: DEMO_PASSWORD }),
  });
  const body = (await res.json()) as { access_token: string; user: { id: string } };
  assert.ok(res.ok, JSON.stringify(body));
  return { token: body.access_token, userId: body.user.id };
}

async function metricas(token: string): Promise<Metricas[]> {
  const res = await fetch(`${url}/rest/v1/rpc/brand_metrics`, {
    method: "POST", headers: { apikey: pub, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_days: null }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as Metricas[];
}

// Uma base única: todos os timestamps são relativos a ela, sem variação entre chamadas
const BASE = Date.now();
const iso = (msAtras: number): string => new Date(BASE - msAtras).toISOString();

/** Pedido com um item e uma revisão feita `atrasoS` segundos depois de recebido. */
async function pedido(n: number, status: string, atrasoS: number, verdict: string): Promise<{ orderId: string; reviewId: string; revisadoEm: number }> {
  const recebido = 3_600_000; // 1 h atrás
  const [o] = (await (await admin("orders", { method: "POST", body: JSON.stringify({
    brand_id: MARCA, shopify_order_id: 970000 + n, order_number: `#M${n}`, raw: {}, status, created_at: iso(recebido),
  }) })).json()) as { id: string }[];
  const [i] = (await (await admin("order_items", { method: "POST", body: JSON.stringify({
    order_id: o!.id, shopify_line_item_id: 980000 + n, title: "Teste", personalisation: { Linha: "x" },
  }) })).json()) as { id: string }[];
  const revisadoEm = recebido - atrasoS * 1000;
  const [r] = (await (await admin("reviews", { method: "POST", body: JSON.stringify({
    order_item_id: i!.id, verdict, issues: [], confidence: 0.9, model: "test", prompt_version: "test", created_at: iso(revisadoEm),
  }) })).json()) as { id: string }[];
  return { orderId: o!.id, reviewId: r!.id, revisadoEm };
}

let ops = { token: "", userId: "" };

before(async () => {
  const s = JSON.parse(execSync("npx -y supabase@latest status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString()) as SupabaseStatus;
  url = s.API_URL; pub = s.PUBLISHABLE_KEY; secret = s.SECRET_KEY;
  ops = await login("ops@demo.test");

  await admin(`brands?id=eq.${MARCA}`, { method: "DELETE" }); // resto de uma execução interrompida
  await admin("brands", { method: "POST", body: JSON.stringify({ id: MARCA, name: "Metrics Test", shop_domain: "metrics-test.myshopify.com" }) });
  await admin("brand_members", { method: "POST", body: JSON.stringify({ brand_id: MARCA, user_id: ops.userId, role: "admin" }) });

  // revisões 10, 20 e 30 s depois do pedido
  const a = await pedido(1, "auto_approved", 10, "ok");
  const b = await pedido(2, "approved", 20, "fix");
  await pedido(3, "needs_review", 30, "unavailable");

  // decisão humana 60 s depois da revisão do pedido 2
  await admin("review_decisions", { method: "POST", body: JSON.stringify({
    review_id: b.reviewId, decided_by: ops.userId, action: "approve", created_at: iso(b.revisadoEm - 60_000),
  }) });
  // pedido 1 sincronizado; pedido 2 decidido e ainda sem sync
  await admin("shopify_sync_log", { method: "POST", body: JSON.stringify({ order_id: a.orderId, mode: "mock", tags: ["t"], ok: true }) });
});

after(async () => {
  if (secret) await admin(`brands?id=eq.${MARCA}`, { method: "DELETE" }); // cascata: pedidos, itens, revisões, decisões, sync
});

test("contagens e percentis da marca batem com os tempos conhecidos", async () => {
  const m = (await metricas(ops.token)).find((r) => r.brand_id === MARCA);
  assert.ok(m, "a marca de teste deve aparecer para o admin dela");
  assert.equal(m.orders_reviewed, 3);
  assert.equal(m.auto_approved, 1);
  assert.equal(m.needs_human, 2);
  assert.equal(m.ai_unavailable, 1);
  assert.equal(Number(m.review_p50_s), 20);
  assert.equal(Number(m.review_p95_s), 29); // interpolação: 20 + 0,9 × (30 − 20)
  assert.equal(Number(m.decision_p50_s), 60);
  assert.equal(Number(m.decision_p95_s), 60);
  assert.equal(m.sync_pending, 1);
});

test("RLS: quem não é membro não vê a marca", async () => {
  const reviewer = await login("reviewer@demo.test"); // revisor só da Engrave & Co
  const linhas = await metricas(reviewer.token);
  assert.ok(!linhas.some((r) => r.brand_id === MARCA));
  assert.deepEqual(linhas.map((r) => r.brand_name), ["Engrave & Co"]);
});

test("anônimo não executa a função", async () => {
  const res = await fetch(`${url}/rest/v1/rpc/brand_metrics`, {
    method: "POST", headers: { apikey: pub, "Content-Type": "application/json" }, body: "{}",
  });
  assert.ok([401, 403].includes(res.status), `anon recebeu ${res.status}`);
});
