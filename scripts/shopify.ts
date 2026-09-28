#!/usr/bin/env node
// Operações na loja de desenvolvimento real (app order-ops-copilot do Dev Dashboard).
//
// Uso (npm run shopify -- <comando>):
//   verificar             obtém um token e mostra loja, moeda e escopos
//   webhook <url>         registra orders/create para <url> (idempotente)
//   webhooks              lista as assinaturas do app
//   pedido <fixture|all>  cria pedidos de teste a partir de fixtures/shopify/
//                         (usa a variante real do SKU quando o produto existe na loja)
//   catalogo              cria as definições de metafield order_ops.* e os produtos
//                         das fixtures com os limites (idempotente; exige write_products)
//
// Requer no .env: SHOPIFY_STORE_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET.
// Os webhooks de assinaturas criadas pelo app são assinados com o client secret.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { credenciaisDoAmbiente, ErroGraphql, graphql, obterToken } from "../lib/shopify-admin.ts";
import { RULES_NAMESPACE } from "../lib/shopify-rules.ts";

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

/** Variante da loja por SKU (null se o produto não existe na loja). */
async function varianteDoSku(loja: string, token: string, sku: string): Promise<string | null> {
  const data = await graphql(loja, token,
    "query($q: String!) { productVariants(first: 1, query: $q) { nodes { id sku } } }", { q: `sku:${sku}` });
  const conexao = data.productVariants;
  const no = ehObjeto(conexao) && Array.isArray(conexao.nodes) ? conexao.nodes.find((n) => ehObjeto(n) && n.sku === sku) : null;
  return ehObjeto(no) ? texto(no.id) || null : null;
}

/**
 * Monta o pedido a partir de uma fixture: mesmos SKUs, títulos e personalização.
 * Com a variante real (catálogo criado), o item aponta para o produto da loja;
 * sem ela, vira um item avulso com título, SKU e preço.
 */
function pedidoDaFixture(fixture: unknown, moeda: string, variantes: Map<string, string>): Record<string, unknown> {
  if (!ehObjeto(fixture) || !Array.isArray(fixture.line_items)) throw new Error("fixture sem line_items");
  const cliente = ehObjeto(fixture.customer) ? fixture.customer : {};
  const email = texto(fixture.email) || "cliente@example.com";
  return {
    test: true,
    currency: moeda,
    email,
    financialStatus: "PAID",
    customer: { toUpsert: { email, firstName: texto(cliente.first_name) || null, lastName: texto(cliente.last_name) || null } },
    lineItems: fixture.line_items.filter(ehObjeto).map((li) => {
      const properties = (Array.isArray(li.properties) ? li.properties : [])
        .filter(ehObjeto).map((p) => ({ name: texto(p.name), value: texto(p.value) }));
      const quantity = typeof li.quantity === "number" ? li.quantity : 1;
      const variantId = variantes.get(texto(li.sku));
      return variantId
        ? { variantId, quantity, properties }
        : {
            title: texto(li.title), sku: texto(li.sku) || null, quantity, requiresShipping: true,
            priceSet: { shopMoney: { amount: texto(li.price) || "0.00", currencyCode: moeda } },
            properties,
          };
    }),
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
    const skus = ehObjeto(fixture) && Array.isArray(fixture.line_items)
      ? fixture.line_items.filter(ehObjeto).map((li) => texto(li.sku)).filter(Boolean) : [];
    const variantes = new Map<string, string>();
    for (const sku of skus) {
      const id = await varianteDoSku(loja, token, sku);
      if (id) variantes.set(sku, id);
    }
    const data = await graphql(loja, token,
      `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
        orderCreate(order: $order, options: $options) {
          order { id name } userErrors { field message }
        }
      }`, { order: pedidoDaFixture(fixture, moeda, variantes), options: { sendReceipt: false, sendFulfillmentReceipt: false } });
    const pedido = ehObjeto(data.orderCreate) && ehObjeto(data.orderCreate.order) ? data.orderCreate.order : {};
    const origem = variantes.size ? `${variantes.size} de ${skus.length} itens com produto da loja` : "itens avulsos";
    console.log(`${arquivo.padEnd(28)} → ${texto(pedido.name)} (${texto(pedido.id)}) · ${origem}`);
  }
}

// ─── Catálogo: produtos das fixtures com as regras em metafields ─────────
// Mesmos SKUs e limites de supabase/seed.sql. Depois de criar, a sincronização
// do n8n (workflow "Sincronizar regras do Shopify") leva as regras ao Postgres.
const CATALOGO = [
  { handle: "engraved-keyring", title: "Engraved Keyring", sku: "ENG-KEYRING", price: "14.99", max_chars: 20, charset: "engraving" },
  { handle: "engraved-watch", title: "Engraved Watch", sku: "ENG-WATCH", price: "89.00", max_chars: 40, charset: "engraving" },
  { handle: "family-name-print", title: "Family Name Print", sku: "PRT-FAMILY", price: "34.00", max_chars: 60, charset: "print" },
  { handle: "embroidered-babygrow", title: "Embroidered Babygrow", sku: "EMB-BABYGROW", price: "22.50", max_chars: 12, charset: "embroidery" },
  { handle: "embroidered-blanket", title: "Embroidered Blanket", sku: "EMB-BLANKET", price: "49.00", max_chars: 24, charset: "embroidery" },
] as const;

const DEFINICOES = [
  { key: "max_chars", name: "Personalisation: max characters", type: "number_integer",
    description: "Limite de caracteres por campo de personalização (Order Ops Copilot)",
    validations: [{ name: "min", value: "1" }, { name: "max", value: "500" }] },
  { key: "charset", name: "Personalisation: technique", type: "single_line_text_field",
    description: "Técnica que define os caracteres permitidos: engraving, print ou embroidery",
    validations: [{ name: "choices", value: JSON.stringify(["engraving", "print", "embroidery"]) }] },
];

async function criarCatalogo(): Promise<void> {
  const { loja, token, escopos } = await sessao();
  if (!escopos.includes("write_products")) {
    throw new Error("o app não tem write_products: lance uma versão do app com esse escopo e reaprove a instalação na loja");
  }

  for (const d of DEFINICOES) {
    try {
      await graphql(loja, token,
        `mutation($d: MetafieldDefinitionInput!) {
          metafieldDefinitionCreate(definition: $d) { createdDefinition { id } userErrors { field message code } }
        }`, { d: { ...d, namespace: RULES_NAMESPACE, ownerType: "PRODUCT" } });
      console.log(`definição ${RULES_NAMESPACE}.${d.key}: criada`);
    } catch (e) {
      // Idempotente: a definição já existir (userError TAKEN) não é erro
      const existe = e instanceof ErroGraphql && Array.isArray(e.erros) && e.erros.some((u) => ehObjeto(u) && u.code === "TAKEN");
      if (existe) console.log(`definição ${RULES_NAMESPACE}.${d.key}: já existia`);
      else throw e;
    }
  }

  for (const p of CATALOGO) {
    const data = await graphql(loja, token,
      `mutation($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
        productSet(input: $input, identifier: $identifier, synchronous: true) {
          product { id handle } userErrors { field message }
        }
      }`, {
        identifier: { handle: p.handle },
        input: {
          title: p.title, handle: p.handle, status: "ACTIVE",
          productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
          variants: [{ optionValues: [{ optionName: "Title", name: "Default Title" }], price: p.price, inventoryItem: { sku: p.sku } }],
          metafields: [
            { namespace: RULES_NAMESPACE, key: "max_chars", type: "number_integer", value: String(p.max_chars) },
            { namespace: RULES_NAMESPACE, key: "charset", type: "single_line_text_field", value: p.charset },
          ],
        },
      });
    const produto = ehObjeto(data.productSet) && ehObjeto(data.productSet.product) ? data.productSet.product : {};
    console.log(`${p.sku.padEnd(13)} ${String(p.max_chars).padStart(3)} ${p.charset.padEnd(10)} → ${texto(produto.id)}`);
  }
}

switch (comando) {
  case "verificar": await verificar(); break;
  case "webhook": await registrarWebhook(args[0]); break;
  case "webhooks": await listarWebhooks(); break;
  case "pedido": await criarPedidos(args[0]); break;
  case "catalogo": await criarCatalogo(); break;
  default:
    console.error("comandos: verificar | webhook <url> | webhooks | pedido <fixture|all> | catalogo");
    process.exit(1);
}
