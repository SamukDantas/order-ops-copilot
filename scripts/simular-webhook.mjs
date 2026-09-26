#!/usr/bin/env node
// Simula o Shopify enviando um webhook orders/create assinado com HMAC.
//
// Uso:
//   node scripts/simular-webhook.mjs <fixture|all> [--novo-id] [--duplicar] [--hmac-invalido]
//
//   --novo-id        gera um id de pedido novo (permite reenviar o mesmo cenário)
//   --duplicar       envia duas vezes com o mesmo X-Shopify-Webhook-Id
//   --hmac-invalido  assina com um segredo errado (deve retornar 401)
//
// Variáveis: WEBHOOK_URL (padrão: função local), SHOPIFY_WEBHOOK_SECRET

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "fixtures", "shopify");
const url = process.env.WEBHOOK_URL ?? "http://127.0.0.1:54321/functions/v1/shopify-webhook";
const secret = process.env.SHOPIFY_WEBHOOK_SECRET ?? "dev-shopify-secret";

const [target, ...flags] = process.argv.slice(2);
if (!target) {
  console.error("Informe um fixture ou 'all':\n  " + readdirSync(dir).map((f) => f.replace(".json", "")).join("\n  "));
  process.exit(1);
}
const has = (f) => flags.includes(f);

const files = target === "all"
  ? readdirSync(dir).filter((f) => f.endsWith(".json"))
  : [target.endsWith(".json") ? target : `${target}.json`];

for (const file of files) {
  const order = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const shop = order._shop;
  delete order._shop;
  if (has("--novo-id")) {
    order.id = Number(`58${Date.now()}`.slice(0, 13)) + Math.floor(Math.random() * 1000);
    order.name = `#${String(order.id).slice(-5)}`;
  }

  const body = JSON.stringify(order);
  const hmac = createHmac("sha256", has("--hmac-invalido") ? "segredo-errado" : secret)
    .update(body, "utf8").digest("base64");
  const webhookId = randomUUID();

  for (let i = 0; i < (has("--duplicar") ? 2 : 1); i++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Topic": "orders/create",
        "X-Shopify-Shop-Domain": shop,
        "X-Shopify-Hmac-Sha256": hmac,
        "X-Shopify-Webhook-Id": webhookId,
        "X-Shopify-API-Version": "2026-07",
      },
      body,
    });
    console.log(`${file.padEnd(28)} ${order.name.padEnd(8)} -> ${res.status} ${await res.text()}`);
  }
}
