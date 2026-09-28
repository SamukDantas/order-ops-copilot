#!/usr/bin/env node
// Expõe os webhooks do n8n local na internet pelo ngrok, com domínio fixo,
// para a Edge Function na nuvem (review-order) e o dashboard na Vercel
// (apply-decision) alcançarem o pipeline que roda nesta máquina.
//
// n8n/ngrok-policy.yml bloqueia tudo que não for POST nesses dois webhooks:
// o editor e a API do n8n não ficam expostos.
//
// Requer no .env: NGROK_DOMAIN (domínio estático do ngrok) e, se o ngrok não
// estiver no PATH, NGROK_BIN. O authtoken vem da configuração do próprio ngrok.
// Uso: npm run tunel  (Ctrl+C encerra)

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const dominio = (process.env.NGROK_DOMAIN ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(dominio)) {
  console.error("defina NGROK_DOMAIN no .env com o domínio estático do ngrok (ex.: nome.ngrok-free.app)");
  process.exit(1);
}

const ngrok = process.env.NGROK_BIN || "ngrok";
const args = ["http", "5678", `--url=https://${dominio}`, `--traffic-policy-file=${join(root, "n8n", "ngrok-policy.yml")}`];

console.log(`webhooks do n8n em https://${dominio}/webhook/{review-order,apply-decision}`);
const filho = spawn(ngrok, args, { stdio: "inherit" });
filho.on("error", (e) => {
  console.error(`não foi possível executar ${ngrok}: ${e.message} (defina NGROK_BIN no .env)`);
  process.exit(1);
});
filho.on("exit", (code) => process.exit(code ?? 0));
for (const sinal of ["SIGINT", "SIGTERM"] as const) process.on(sinal, () => filho.kill(sinal));
