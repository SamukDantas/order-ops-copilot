#!/usr/bin/env node
// Prepara o ambiente local:
//  1. cria .env a partir de .env.example (gera N8N_WEBHOOK_SECRET)
//  2. lê a chave secreta do Supabase local (`supabase status`)
//  3. escreve supabase/functions/.env para a Edge Function
//  4. gera as credenciais do n8n em n8n/.credentials/ (fora do git)
//
// Não sobrescreve valores já preenchidos no .env.

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");

const parse = (txt) => Object.fromEntries(
  txt.split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(join(root, ".env.example"), "utf8");
const set = (key, value) => {
  const cur = parse(text)[key];
  if (cur) return; // já preenchido: respeita o usuário
  const linha = new RegExp(`^${key}=.*$`, "m");
  text = linha.test(text) ? text.replace(linha, `${key}=${value}`) : `${text.trimEnd()}
${key}=${value}
`;
};

// Padrões para .env criados antes destas variáveis existirem
set("LLM_PROVEDOR", "codex");
set("CODEX_RUN_MODEL", "gpt-5.6-luna");
set("CODEX_FALLBACK_MODEL", "gpt-5.6-terra");
set("LLM_GATEWAY_URL", "http://host.docker.internal:8787");

set("N8N_WEBHOOK_SECRET", randomBytes(24).toString("hex"));
set("LLM_GATEWAY_SECRET", randomBytes(24).toString("hex"));

let status = null;
try {
  status = JSON.parse(execSync("npx -y supabase@latest status -o json", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString());
  const secret = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
  if (secret) set("SUPABASE_SECRET_KEY", secret);
} catch {
  console.warn("! Supabase local não está rodando (npx supabase start). SUPABASE_SECRET_KEY não preenchida.");
}

writeFileSync(envPath, text);
const env = parse(text);

// Edge Function: vê o n8n pelo host
mkdirSync(join(root, "supabase", "functions"), { recursive: true });
writeFileSync(join(root, "supabase", "functions", ".env"), [
  `SHOPIFY_WEBHOOK_SECRET=${env.SHOPIFY_WEBHOOK_SECRET}`,
  `N8N_REVIEW_WEBHOOK_URL=http://host.docker.internal:5678/webhook/review-order`,
  `N8N_WEBHOOK_SECRET=${env.N8N_WEBHOOK_SECRET}`,
].join("\n") + "\n");

// Dashboard: só a chave publicável (o RLS protege os dados)
if (status) {
  writeFileSync(join(root, "web", ".env.local"), [
    `NEXT_PUBLIC_SUPABASE_URL=${status.API_URL}`,
    `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${status.PUBLISHABLE_KEY ?? status.ANON_KEY}`,
    `N8N_BASE_URL=http://localhost:5678`,
    `N8N_WEBHOOK_SECRET=${env.N8N_WEBHOOK_SECRET}`,
  ].join("\n") + "\n");
}

// Credenciais do n8n (IDs fixos referenciados pelos workflows gerados)
const credsDir = join(root, "n8n", ".credentials");
mkdirSync(credsDir, { recursive: true });
const credentials = [
  { id: "ooCredLlmGateway", name: "LLM gateway secret", type: "httpHeaderAuth",
    data: { name: "x-gateway-secret", value: env.LLM_GATEWAY_SECRET } },
  { id: "ooCredSupabase01", name: "Supabase service role", type: "httpCustomAuth",
    data: { json: JSON.stringify({ headers: {
      apikey: env.SUPABASE_SECRET_KEY ?? "",
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY ?? ""}`,
      "Content-Type": "application/json",
    } }) } },
  { id: "ooCredWebhook001", name: "n8n webhook secret", type: "httpHeaderAuth",
    data: { name: "x-webhook-secret", value: env.N8N_WEBHOOK_SECRET } },
  { id: "ooCredShopify001", name: "Shopify Admin API", type: "httpHeaderAuth",
    data: { name: "X-Shopify-Access-Token", value: env.SHOPIFY_ADMIN_TOKEN ?? "" } },
];
writeFileSync(join(credsDir, "credentials.json"), JSON.stringify(credentials, null, 2));

const missing = ["SUPABASE_SECRET_KEY", ...(env.LLM_PROVEDOR === "anthropic" ? ["ANTHROPIC_API_KEY"] : [])].filter((k) => !env[k]);
console.log("✓ .env, supabase/functions/.env e n8n/.credentials/credentials.json atualizados");
if (missing.length) console.log("! Falta preencher no .env: " + missing.join(", ") + " (e rodar `npm run setup` de novo)");
