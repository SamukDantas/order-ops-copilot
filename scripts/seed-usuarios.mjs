#!/usr/bin/env node
// Cria usuários de demonstração no Supabase LOCAL e os vincula às marcas.
// Senha fixa apenas para desenvolvimento local; nunca rode contra produção.
//
//   ops@demo.test        admin nas duas marcas
//   reviewer@demo.test   revisor só na Engrave & Co
//   viewer@demo.test     somente leitura na Little Stitch

import { execSync } from "node:child_process";

import { DEMO_PASSWORD } from "./demo-config.mjs";

const status = JSON.parse(execSync("npx -y supabase@latest status -o json", { stdio: ["ignore", "pipe", "ignore"] }).toString());
const url = status.API_URL;
const key = status.SECRET_KEY;
if (!/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) throw new Error(`Recusado: ${url} não é local`);

const ENGRAVE = "11111111-1111-4111-8111-111111111111";
const STITCH = "22222222-2222-4222-8222-222222222222";
const USERS = [
  { email: "ops@demo.test", memberships: [[ENGRAVE, "admin"], [STITCH, "admin"]] },
  { email: "reviewer@demo.test", memberships: [[ENGRAVE, "reviewer"]] },
  { email: "viewer@demo.test", memberships: [[STITCH, "viewer"]] },
];

const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function findUser(email) {
  const res = await fetch(`${url}/auth/v1/admin/users?per_page=200`, { headers });
  const { users } = await res.json();
  return users.find((u) => u.email === email);
}

for (const u of USERS) {
  let user = await findUser(u.email);
  if (!user) {
    const res = await fetch(`${url}/auth/v1/admin/users`, {
      method: "POST", headers,
      body: JSON.stringify({ email: u.email, password: DEMO_PASSWORD, email_confirm: true }),
    });
    user = await res.json();
    if (!res.ok) throw new Error(`${u.email}: ${JSON.stringify(user)}`);
  }
  const rows = u.memberships.map(([brand_id, role]) => ({ brand_id, user_id: user.id, role }));
  const res = await fetch(`${url}/rest/v1/brand_members?on_conflict=brand_id,user_id`, {
    method: "POST", headers: { ...headers, Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${u.email}: ${await res.text()}`);
  console.log(`✓ ${u.email.padEnd(20)} ${u.memberships.map(([, r]) => r).join(", ")}`);
}
console.log("Senha (somente local): veja scripts/demo-config.mjs");
