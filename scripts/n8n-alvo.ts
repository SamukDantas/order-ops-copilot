#!/usr/bin/env node
// Alterna o Supabase que o n8n usa: `local` (padrão do desenvolvimento) ou
// `nuvem` (o projeto da demo online, que recebe os webhooks da loja real).
//
// nuvem: busca a chave secreta do projeto pela Management API
// (SUPABASE_ACCESS_TOKEN_DEMO), grava n8n/.env.alvo (fora do git) com
// SUPABASE_URL e SUPABASE_SECRET_KEY, que o compose carrega depois do .env,
// e atualiza a credencial "Supabase service role" do n8n.
// local: apaga n8n/.env.alvo e volta a credencial para a chave do .env.
//
// Nos dois casos recria o container e reimporta credenciais e workflows.
// Uso: npm run n8n:alvo -- <local|nuvem>

import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arquivoAlvo = join(root, "n8n", ".env.alvo");
const arquivoCreds = join(root, "n8n", ".credentials", "credentials.json");

const ehObjeto = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

const alvo = process.argv[2];
if (alvo !== "local" && alvo !== "nuvem") {
  console.error("uso: npm run n8n:alvo -- <local|nuvem>");
  process.exit(1);
}

async function chaveDaNuvem(ref: string): Promise<string> {
  const token = process.env.SUPABASE_ACCESS_TOKEN_DEMO;
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN_DEMO não definido no .env");
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const corpo: unknown = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(corpo)) throw new Error(`Management API respondeu ${res.status}`);
  const chaves = corpo.filter(ehObjeto);
  // Prefere a chave secreta nova (sb_secret_...); cai para a service_role legada
  const escolhida = chaves.find((k) => k.type === "secret") ?? chaves.find((k) => k.name === "service_role");
  if (!escolhida || typeof escolhida.api_key !== "string") throw new Error(`o projeto ${ref} não tem chave secreta`);
  return escolhida.api_key;
}

let url: string;
let chave: string;
if (alvo === "nuvem") {
  const arquivoRef = join(root, "supabase", ".temp", "project-ref");
  if (!existsSync(arquivoRef)) throw new Error("supabase/.temp/project-ref não existe: rode `npx supabase link --project-ref <ref>`");
  const ref = readFileSync(arquivoRef, "utf8").trim();
  url = `https://${ref}.supabase.co`;
  chave = await chaveDaNuvem(ref);
  writeFileSync(arquivoAlvo, `# Gerado por npm run n8n:alvo -- nuvem. Não versionar.\nSUPABASE_URL=${url}\nSUPABASE_SECRET_KEY=${chave}\n`, { mode: 0o600 });
} else {
  url = process.env.SUPABASE_URL ?? "";
  chave = process.env.SUPABASE_SECRET_KEY ?? "";
  if (!chave) throw new Error("SUPABASE_SECRET_KEY não definido no .env (rode npm run setup)");
  rmSync(arquivoAlvo, { force: true });
}

if (!existsSync(arquivoCreds)) throw new Error("n8n/.credentials/credentials.json não existe: rode npm run setup");
const creds: unknown = JSON.parse(readFileSync(arquivoCreds, "utf8"));
if (!Array.isArray(creds)) throw new Error("credentials.json inválido");
const supabase = creds.find((c) => ehObjeto(c) && c.id === "ooCredSupabase01");
if (!ehObjeto(supabase)) throw new Error("credencial ooCredSupabase01 não encontrada");
supabase.data = { json: JSON.stringify({ headers: { apikey: chave, Authorization: `Bearer ${chave}`, "Content-Type": "application/json" } }) };
writeFileSync(arquivoCreds, JSON.stringify(creds, null, 2));

execSync("docker compose -f n8n/docker-compose.yml up -d --force-recreate", { cwd: root, stdio: "inherit" });
execSync("node scripts/n8n-importar.ts", { cwd: root, stdio: "inherit" });
console.log(`✓ n8n apontando para ${alvo === "nuvem" ? url : `Supabase local (${url})`}`);
