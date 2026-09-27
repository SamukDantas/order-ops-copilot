#!/usr/bin/env node
// Carrega (ou reseta) os dados da demo online no projeto Supabase vinculado
// (`npx supabase link`) e dá ao usuário demo o papel de revisor nas duas marcas.
//
// O usuário demo é criado por uma pessoa no painel do Supabase (Authentication →
// Add user); este script só cuida dos dados e do vínculo com as marcas.
//
// Requer no .env: SUPABASE_DB_PASSWORD e DEMO_EMAIL.
// Uso: npm run demo:carregar

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = join(root, "supabase", ".temp");

const ler = (arquivo: string): string => {
  const p = join(temp, arquivo);
  if (!existsSync(p)) throw new Error(`supabase/.temp/${arquivo} não existe: rode \`npx supabase link --project-ref <ref>\` antes.`);
  return readFileSync(p, "utf8").trim();
};

const senha = process.env.SUPABASE_DB_PASSWORD;
const email = process.env.DEMO_EMAIL;
if (!senha) throw new Error("SUPABASE_DB_PASSWORD não definido no .env");
if (!email) throw new Error("DEMO_EMAIL não definido no .env");

const ref = ler("project-ref");
const pooler = ler("pooler-url"); // postgresql://postgres.<ref>@<host>:<porta>/postgres (sem senha)
if (!pooler.includes(ref)) throw new Error(`pooler-url não corresponde ao projeto ${ref}`);

const sql = readFileSync(join(root, "supabase", "demo", "demo-data.sql"), "utf8") + `
insert into public.brand_members (brand_id, user_id, role)
select b.id, u.id, 'reviewer' from public.brands b cross join auth.users u
where u.email = :'demo_email'
on conflict (brand_id, user_id) do update set role = excluded.role;

select 'pedidos' as item, count(*)::text as total from public.orders
union all select 'revisões', count(*)::text from public.reviews
union all select 'vínculos do usuário demo', count(*)::text
  from public.brand_members m join auth.users u on u.id = m.user_id where u.email = :'demo_email';
`;

// psql do container oficial do Postgres: não exige cliente instalado no host.
// A senha vai por variável de ambiente (PGPASSWORD), nunca pela linha de comando.
const r = spawnSync("docker", [
  "run", "--rm", "-i", "-e", "PGPASSWORD", "postgres:17",
  "psql", pooler, "-v", "ON_ERROR_STOP=1", "-v", `demo_email=${email}`, "-q", "-At", "-F", ": ",
], { input: sql, env: { ...process.env, PGPASSWORD: senha }, encoding: "utf8" });

process.stdout.write(r.stdout ?? "");
if (r.status !== 0) {
  process.stderr.write(r.stderr ?? "");
  throw new Error(`psql falhou (exit ${r.status})`);
}
console.log(`✓ demo carregada no projeto ${ref}`);
