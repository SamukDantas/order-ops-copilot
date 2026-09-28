// Teste de integração da sincronização de regras (sync_product_rules) contra o
// Supabase LOCAL, numa marca isolada.
// Pré-requisitos: `supabase start` e `node scripts/seed-usuarios.ts`.
//
// Uso: npm run test:integration

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { DEMO_PASSWORD } from "../scripts/demo-config.ts";

interface SupabaseStatus { API_URL: string; PUBLISHABLE_KEY: string; SECRET_KEY: string }
interface Regra { sku: string; max_chars: number; charset: string; source: string }

const MARCA = "55555555-5555-4555-8555-555555555555";
const LOJA = "regras-teste.myshopify.com";
let url = "";
let pub = "";
let secret = "";

const admin = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${url}/rest/v1/${path}`, {
  ...init,
  headers: { apikey: secret, Authorization: `Bearer ${secret}`, "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
});

const sync = (regras: unknown, loja = LOJA): Promise<Response> =>
  admin("rpc/sync_product_rules", { method: "POST", body: JSON.stringify({ p_shop_domain: loja, p_rules: regras }) });

async function regras(): Promise<Regra[]> {
  const res = await admin(`product_rules?brand_id=eq.${MARCA}&select=sku,max_chars,charset,source&order=sku`);
  return (await res.json()) as Regra[];
}

before(async () => {
  const s = JSON.parse(execSync("npx -y supabase@latest status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString()) as SupabaseStatus;
  url = s.API_URL; pub = s.PUBLISHABLE_KEY; secret = s.SECRET_KEY;
  await admin(`brands?id=eq.${MARCA}`, { method: "DELETE" });
  assert.ok((await admin("brands", { method: "POST", body: JSON.stringify({ id: MARCA, name: "Rules Test", shop_domain: LOJA }) })).ok);
  // duas regras cadastradas à mão
  assert.ok((await admin("product_rules", { method: "POST", body: JSON.stringify([
    { brand_id: MARCA, sku: "M-1", max_chars: 20, charset: "engraving" },
    { brand_id: MARCA, sku: "M-2", max_chars: 12, charset: "embroidery" },
  ]) })).ok);
});

after(async () => {
  if (secret) await admin(`brands?id=eq.${MARCA}`, { method: "DELETE" });
});

test("regra da loja substitui a manual do mesmo SKU; as outras manuais ficam", async () => {
  const res = await sync([{ sku: "M-1", max_chars: 30, charset: "print" }, { sku: "S-1", max_chars: 40, charset: "engraving" }]);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { brand_id: MARCA, upserted: 2, removed: 0 });
  assert.deepEqual(await regras(), [
    { sku: "M-1", max_chars: 30, charset: "print", source: "shopify" },
    { sku: "M-2", max_chars: 12, charset: "embroidery", source: "manual" },
    { sku: "S-1", max_chars: 40, charset: "engraving", source: "shopify" },
  ]);
});

test("regra que sumiu da loja é removida; manual continua", async () => {
  const res = await sync([{ sku: "S-1", max_chars: 45, charset: "engraving" }]);
  assert.deepEqual(await res.json(), { brand_id: MARCA, upserted: 1, removed: 1 });
  assert.deepEqual(await regras(), [
    { sku: "M-2", max_chars: 12, charset: "embroidery", source: "manual" },
    { sku: "S-1", max_chars: 45, charset: "engraving", source: "shopify" },
  ]);
});

test("regra inválida desfaz a sincronização inteira", async () => {
  const res = await sync([{ sku: "S-1", max_chars: 50, charset: "engraving" }, { sku: "S-2", max_chars: 0, charset: "print" }]);
  assert.ok(!res.ok, "max_chars 0 viola a constraint");
  assert.equal((await regras()).find((r) => r.sku === "S-1")?.max_chars, 45, "nada mudou");
});

test("loja desconhecida é recusada", async () => {
  const res = await sync([], "nao-existe.myshopify.com");
  assert.ok(!res.ok);
  assert.match(await res.text(), /loja desconhecida/);
});

test("só a service_role executa a sincronização", async () => {
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: pub, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ops@demo.test", password: DEMO_PASSWORD }),
  });
  const { access_token } = (await login.json()) as { access_token: string };
  const res = await fetch(`${url}/rest/v1/rpc/sync_product_rules`, {
    method: "POST", headers: { apikey: pub, Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_shop_domain: LOJA, p_rules: [] }),
  });
  assert.equal(res.status, 403);
});
