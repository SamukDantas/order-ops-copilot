#!/usr/bin/env node
// Importa credenciais e workflows no n8n local (container order-ops-n8n) e os ativa.
// Idempotente: IDs fixos fazem a reimportação atualizar em vez de duplicar.

import { execSync } from "node:child_process";

const C = "order-ops-n8n";
const WORKFLOWS = ["ooTratarErros001", "ooAplicarDecisa1", "ooRevisarPedido1"];

const run = (cmd: string, { tolerate = false } = {}): boolean => {
  try {
    const out = execSync(`docker exec ${C} ${cmd}`, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    if (out) console.log(out.split("\n").slice(-3).join("\n"));
    return true;
  } catch (e) {
    const detalhe = (e as { stderr?: Buffer }).stderr?.toString() ?? (e instanceof Error ? e.message : String(e));
    if (!tolerate) throw new Error(`${cmd}\n${detalhe}`);
    return false;
  }
};

run("n8n import:credentials --input=/import/credentials/credentials.json");
run("n8n import:workflow --separate --input=/import/workflows");

for (const id of WORKFLOWS) {
  // n8n 2.x usa publish:workflow; 1.x usa update:workflow --active=true
  if (!run(`n8n publish:workflow --id=${id}`, { tolerate: true })) {
    run(`n8n update:workflow --id=${id} --active=true`);
  }
}

execSync(`docker restart ${C}`, { stdio: "ignore" });
console.log("✓ credenciais e workflows importados e ativados; n8n reiniciado");
