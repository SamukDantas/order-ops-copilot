#!/usr/bin/env node
// Operações na loja de desenvolvimento real (app order-ops-copilot do Dev Dashboard).
//
// Uso (npm run shopify -- <comando>):
//   verificar             obtém um token e mostra loja, moeda e escopos
//   webhook <url>         registra orders/create para <url> (idempotente)
//   webhooks              lista as assinaturas do app
//   pedido <fixture|all>  cria pedidos de teste a partir de fixtures/shopify/
//
// Requer no .env: SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET.
// Os webhooks de assinaturas criadas pelo app são assinados com o client secret.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { credenciaisDoAmbiente, graphql, obterToken } from "../lib/shopify-admin.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirFixtures = join(root, "fixtures", "shopify");

const ehObjeto = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const texto = (x: unknown): string => (typeof x === "string" ? x : "");

const credenciais = credenciaisDoAmbiente();
const [comando, ...args] = process.argv.slice(2);

async function sessao(): Promise<{ loja: string; token: string; escopos: string[] }> {
  const t = await obterToken(credenciais);
  return { loja: credenciais.loja, token: t.accessToken, escopos: t.escopos };
}

async function verificar(): Promise<void> {
  const { loja, token, escopos } = await sessao();
  const data = await graphql(loja, token, "{ shop { name myshopifyDomain currencyCode plan { partnerDevelopment } } }");
  const shop = ehObjeto(data.shop) ? data.shop : {};
  console.log(`Loja:     ${texto(shop.name)} (${texto(shop.myshopifyDomain)})`);
  console.log(`Moeda:    ${texto(shop.currencyCode)}`);
  console.log(`Escopos:  ${escopos.join(", ") || "(nenhum)"}`);
  console.log("Token:    ok (válido por 24 h; não é exibido)");
}

interface Assinatura { id: string; topic: string; uri: string }

async function listarAssinaturas(loja: string, token: string): Promise<Assinatura[]> {
  const data = await graphql(loja, token, "{ webhookSubscriptions(first: 50) { nodes { id topic uri } } }");
  const conexao = data.webhookSubscriptions;
  const nodes = ehObjeto(conexao) && Array.isArray(conexao.nodes) ? conexao.nodes : [];
  return nodes.filter(ehObjeto).map((n) => ({ id: texto(n.id), topic: texto(n.topic), uri: texto(n.uri) }));
}

async function registrarWebhook(url: string | undefined): Promise<void> {
  if (!url || !/^https:\/\//.test(url)) throw new Error("informe a URL https do webhook: npm run shopify -- webhook <url>");
  const { loja, token } = await sessao();
  const existentes = (await listarAssinaturas(loja, token)).filter((a) => a.topic === "ORDERS_CREATE");

  if (existentes.some((a) => a.uri === url)) {
    console.log(`orders/create já aponta para ${url}`);
  } else {
    const data = await graphql(loja, token,
      `mutation($uri: String!) {
        webhookSubscriptionCreate(topic: ORDERS_CREATE, webhookSubscription: { uri: $uri, format: JSON }) {
          webhookSubscription { id } userErrors { field message }
        }
      }`, { uri: url });
    const criada = ehObjeto(data.webhookSubscriptionCreate) && ehObjeto(data.webhookSubscriptionCreate.webhookSubscription)
      ? texto(data.webhookSubscriptionCreate.webhookSubscription.id) : "";
    console.log(`orders/create → ${url} (${criada})`);
  }

  // Uma assinatura por tópico: remove as que apontam para URLs antigas.
  for (const a of existentes.filter((a) => a.uri !== url)) {
    await graphql(loja, token,
      "mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } } }",
      { id: a.id });
    console.log(`removida assinatura antiga → ${a.uri}`);
  }
}

async function listarWebhooks(): Promise<void> {
  const { loja, token } = await sessao();
  const assinaturas = await listarAssinaturas(loja, token);
  if (!assinaturas.length) console.log("nenhuma assinatura");
  for (const a of assinaturas) console.log(`${a.topic} → ${a.uri}`);
}

/** Monta o pedido a partir de uma fixture: mesmos SKUs, títulos e personalização. */
function pedidoDaFixture(fixture: unknown, moeda: string): Record<string, unknown> {
  if (!ehObjeto(fixture) || !Array.isArray(fixture.line_items)) throw new Error("fixture sem line_items");
  const cliente = ehObjeto(fixture.customer) ? fixture.customer : {};
  const email = texto(fixture.email) || "cliente@example.com";
  return {
    test: true,
    currency: moeda,
    email,
    financialStatus: "PAID",
    customer: { toUpsert: { email, firstName: texto(cliente.first_name) || null, lastName: texto(cliente.last_name) || null } },
    lineItems: fixture.line_items.filter(ehObjeto).map((li) => ({
      title: texto(li.title),
      sku: texto(li.sku) || null,
      quantity: typeof li.quantity === "number" ? li.quantity : 1,
      requiresShipping: true,
      priceSet: { shopMoney: { amount: texto(li.price) || "0.00", currencyCode: moeda } },
      properties: (Array.isArray(li.properties) ? li.properties : [])
        .filter(ehObjeto).map((p) => ({ name: texto(p.name), value: texto(p.value) })),
    })),
  };
}

async function criarPedidos(alvo: string | undefined): Promise<void> {
  const todas = readdirSync(dirFixtures).filter((f) => f.endsWith(".json"));
  if (!alvo) throw new Error(`informe uma fixture ou 'all':\n  ${todas.map((f) => f.replace(".json", "")).join("\n  ")}`);
  const arquivos = alvo === "all" ? todas : [alvo.endsWith(".json") ? alvo : `${alvo}.json`];

  const { loja, token } = await sessao();
  const shop = await graphql(loja, token, "{ shop { currencyCode } }");
  const moeda = ehObjeto(shop.shop) ? texto(shop.shop.currencyCode) : "";
  if (!moeda) throw new Error("não foi possível ler a moeda da loja");

  for (const [i, arquivo] of arquivos.entries()) {
    // Lojas de desenvolvimento aceitam até 5 pedidos novos por minuto.
    if (i > 0 && i % 5 === 0) {
      console.log("aguardando 60 s (limite de 5 pedidos/min em loja de desenvolvimento)...");
      await new Promise((r) => setTimeout(r, 60_000));
    }
    const fixture: unknown = JSON.parse(readFileSync(join(dirFixtures, arquivo), "utf8"));
    const data = await graphql(loja, token,
      `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
        orderCreate(order: $order, options: $options) {
          order { id name } userErrors { field message }
        }
      }`, { order: pedidoDaFixture(fixture, moeda), options: { sendReceipt: false, sendFulfillmentReceipt: false } });
    const pedido = ehObjeto(data.orderCreate) && ehObjeto(data.orderCreate.order) ? data.orderCreate.order : {};
    console.log(`${arquivo.padEnd(28)} → ${texto(pedido.name)} (${texto(pedido.id)})`);
  }
}

switch (comando) {
  case "verificar": await verificar(); break;
  case "webhook": await registrarWebhook(args[0]); break;
  case "webhooks": await listarWebhooks(); break;
  case "pedido": await criarPedidos(args[0]); break;
  default:
    console.error("comandos: verificar | webhook <url> | webhooks | pedido <fixture|all>");
    process.exit(1);
}
