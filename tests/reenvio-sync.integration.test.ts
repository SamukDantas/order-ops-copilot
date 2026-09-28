// Teste de integração do reenvio do write-back (orders_pending_sync) contra o
// Supabase LOCAL. Pré-requisitos: `supabase start`, `node scripts/seed-usuarios.ts`
// e pedidos das duas marcas (`npm run simular -- all`).
//
// Uso: npm run test:integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { DEMO_PASSWORD } from "../scripts/demo-config.ts";

interface SupabaseStatus { API_URL: string; PUBLISHABLE_KEY: string; SECRET_KEY: string }
interface OrderRow { id: string; status: string }

let url = "";
let pub = "";
let secret = "";
const originais = new Map<string, string>(); // pedido → status antes do teste

before(() => {
  const s = JSON.parse(execSync("npx -y supabase@latest status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString()) as SupabaseStatus;
  url = s.API_URL; pub = s.PUBLISHABLE_KEY; secret = s.SECRET_KEY;
});

const admin = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${url}/rest/v1/${path}`, {
  ...init,
  headers: { apikey: secret, Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
});

async function pendentes(): Promise<string[]> {
  // p_older_than 0: o teste não espera os 2 minutos de folga da produção
  const res = await admin("rpc/orders_pending_sync", { method: "POST", body: JSON.stringify({ p_older_than: "0 seconds", p_limit: 500 }) });
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { order_id: string }[]).map((r) => r.order_id);
}

/** Decide o pedido agora (o trigger renova status_changed_at), guardando o status original. */
async function decidirAgora(id: string, status: string): Promise<void> {
  const res = await admin(`orders?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "reviewing" }) });
  assert.ok(res.ok);
  await admin(`orders?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
}

async function registrarSync(orderId: string, ok: boolean): Promise<void> {
  const res = await admin("shopify_sync_log", { method: "POST", body: JSON.stringify({ order_id: orderId, mode: "mock", tags: ["teste"], ok }) });
  assert.ok(res.ok, await res.text());
}

async function doisPedidos(): Promise<[string, string]> {
  const rows = (await (await admin("orders?select=id,status&order=created_at&limit=2")).json()) as OrderRow[];
  assert.equal(rows.length, 2, "rode npm run simular -- all antes");
  for (const r of rows) originais.set(r.id, r.status);
  return [rows[0]!.id, rows[1]!.id];
}

after(async () => {
  for (const [id, status] of originais) await admin(`orders?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
});

test("pedido decidido sem sync entra na fila; um sync bem-sucedido o tira", async () => {
  const [a] = await doisPedidos();
  await decidirAgora(a, "approved");
  assert.ok((await pendentes()).includes(a));

  await registrarSync(a, true);
  assert.ok(!(await pendentes()).includes(a));
});

test("para de reenviar depois de 5 falhas registradas", async () => {
  const [, b] = await doisPedidos();
  await decidirAgora(b, "rejected");
  for (let i = 0; i < 4; i++) await registrarSync(b, false);
  assert.ok((await pendentes()).includes(b), "com 4 falhas ainda reenvia");

  await registrarSync(b, false);
  assert.ok(!(await pendentes()).includes(b), "com 5 falhas desiste");
});

test("uma nova decisão zera a contagem: só vale o que veio depois dela", async () => {
  const [a] = await doisPedidos();
  await decidirAgora(a, "approved");
  assert.ok((await pendentes()).includes(a), "o sync ok anterior à decisão não conta");
});

test("pedido não decidido nunca entra na fila", async () => {
  const [a] = await doisPedidos();
  await decidirAgora(a, "needs_review");
  assert.ok(!(await pendentes()).includes(a));
});

test("só a service_role executa a função", async () => {
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: pub, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ops@demo.test", password: DEMO_PASSWORD }),
  });
  const { access_token } = (await login.json()) as { access_token: string };
  const res = await fetch(`${url}/rest/v1/rpc/orders_pending_sync`, {
    method: "POST", headers: { apikey: pub, Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(res.status, 403, "usuário autenticado (mesmo admin da marca) não pode listar a fila");
  const anon = await fetch(`${url}/rest/v1/rpc/orders_pending_sync`, {
    method: "POST", headers: { apikey: pub, "Content-Type": "application/json" }, body: "{}",
  });
  assert.ok([401, 403].includes(anon.status), `anon recebeu ${anon.status}`);
});
