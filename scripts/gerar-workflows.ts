#!/usr/bin/env node
// Gera os workflows do n8n (n8n/workflows/*.json) a partir do código versionado:
// o prompt, o schema e a lógica de roteamento vêm de lib/ e prompts/, então o
// workflow que roda é sempre o mesmo que os testes e o eval exercitam.
//
// Uso: node scripts/gerar-workflows.ts

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SYSTEM_PROMPT, OUTPUT_SCHEMA, MODEL, PROMPT_VERSION, buildReviewRequest } from "../lib/review-request.ts";

// ─── Formato dos workflows do n8n (o subconjunto que geramos) ─────────
type Position = [number, number];
interface Credential { id: string; name: string }
interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: Position;
  parameters: Record<string, unknown>;
  webhookId?: string;
  credentials?: Record<string, Credential>;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  onError?: "continueRegularOutput" | "stopWorkflow";
}
interface Connection { node: string; type: "main"; index: number }
type Connections = Record<string, { main: Connection[][] }>;
interface Workflow {
  id: string;
  name: string;
  active: boolean;
  nodes: N8nNode[];
  connections: Connections;
  settings: { executionOrder: "v1"; errorWorkflow?: string };
  pinData: Record<string, never>;
  tags: string[];
}
interface Header { name: string; value: string }
type CodeMode = "runOnceForAllItems" | "runOnceForEachItem";

/**
 * O Code node do n8n roda JavaScript: o TypeScript de lib/ entra sem tipos.
 * O Node troca cada tipo por espaços para preservar posições; aqui os espaços
 * são normalizados para o JSON gerado continuar legível.
 */
function paraJs(ts: string): string {
  return ts
    .replace(/(\S) {2,}/g, "$1 ")
    .replace(/(\S) +([;),])/g, "$1$2")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "n8n", "workflows");
mkdirSync(outDir, { recursive: true });

// ─── IDs estáveis (reimportar atualiza em vez de duplicar) ───────────
const WF = { revisar: "ooRevisarPedido1", aplicar: "ooAplicarDecisa1", erros: "ooTratarErros001" };
const CRED = {
  llm: { id: "ooCredLlmGateway", name: "LLM gateway secret" },
  supabase: { id: "ooCredSupabase01", name: "Supabase service role" },
  webhook: { id: "ooCredWebhook001", name: "n8n webhook secret" },
  shopify: { id: "ooCredShopify001", name: "Shopify Admin API" },
};

// Lógica pura reaproveitada no Code node: sem tipos e sem "export"
const reviewLogicSrc = paraJs(
  stripTypeScriptTypes(readFileSync(join(root, "lib", "review-logic.ts"), "utf8")).replace(/^export /gm, ""),
);
// buildReviewRequest já chega sem tipos: o Node os removeu ao carregar o módulo
const buildRequestSrc = paraJs(`const SYSTEM_PROMPT = ${JSON.stringify(SYSTEM_PROMPT)};
const OUTPUT_SCHEMA = ${JSON.stringify(OUTPUT_SCHEMA)};
const MODEL = ${JSON.stringify(MODEL)};
const PROMPT_VERSION = ${JSON.stringify(PROMPT_VERSION)};
${buildReviewRequest.toString()}`);

// ─── Helpers de nós ──────────────────────────────────────────────────
const pos = (col: number, row = 0): Position => [col * 260, 300 + row * 200];

const supabaseAuth = {
  authentication: "genericCredentialType",
  genericAuthType: "httpCustomAuth",
};
const supabaseCreds = { httpCustomAuth: CRED.supabase };

interface HttpOptions {
  method?: "GET" | "POST" | "PATCH";
  url: string;
  body?: string;
  headers?: Header[];
  auth?: Record<string, string>;
  creds?: Record<string, Credential>;
  extra?: Partial<N8nNode>;
  options?: Record<string, unknown>;
}

function httpJson(name: string, position: Position, { method = "POST", url, body, headers = [], auth, creds, extra = {}, options = {} }: HttpOptions): N8nNode {
  return {
    id: slug(name), name, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position,
    parameters: {
      method, url,
      ...(auth ?? {}),
      sendHeaders: headers.length > 0,
      headerParameters: { parameters: headers },
      ...(body !== undefined ? { sendBody: true, specifyBody: "json", jsonBody: body } : {}),
      options,
    },
    ...(creds ? { credentials: creds } : {}),
    ...extra,
  };
}

function code(name: string, position: Position, jsCode: string, mode: CodeMode = "runOnceForAllItems"): N8nNode {
  return {
    id: slug(name), name, type: "n8n-nodes-base.code", typeVersion: 2, position,
    parameters: { mode, jsCode },
  };
}

function webhook(name: string, position: Position, path: string, webhookId: string): N8nNode {
  return {
    id: slug(name), name, type: "n8n-nodes-base.webhook", typeVersion: 2, position, webhookId,
    parameters: {
      httpMethod: "POST", path, authentication: "headerAuth", responseMode: "onReceived",
      options: { responseCode: 202 },
    },
    credentials: { httpHeaderAuth: CRED.webhook },
  };
}

function ifNode(name: string, position: Position, leftValue: string, rightValue: string): N8nNode {
  return {
    id: slug(name), name, type: "n8n-nodes-base.if", typeVersion: 2, position,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{ id: slug(name) + "-c", leftValue, rightValue, operator: { type: "string", operation: "equals" } }],
        combinator: "and",
      },
      options: {},
    },
  };
}

function slug(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

type Ligacao = [from: string, to: string, outIndex?: number];

function connect(pairs: Ligacao[]): Connections {
  const c: Connections = {};
  for (const [from, to, outIndex = 0] of pairs) {
    const saidas = (c[from] ??= { main: [] }).main;
    while (saidas.length <= outIndex) saidas.push([]);
    saidas[outIndex]?.push({ node: to, type: "main", index: 0 });
  }
  return c;
}

function workflow(id: string, name: string, nodes: N8nNode[], connections: Connections,
  { errorWorkflow = WF.erros }: { errorWorkflow?: string | null } = {}): Workflow {
  return {
    id, name, active: false, nodes, connections,
    settings: { executionOrder: "v1", ...(errorWorkflow && id !== WF.erros ? { errorWorkflow } : {}) },
    pinData: {}, tags: [],
  };
}

const SUPA = "={{ $env.SUPABASE_URL }}";

// ═══ 1. Revisar pedido ═══════════════════════════════════════════════
const revisarNodes = [
  webhook("Webhook: pedido novo", pos(0, 0), "review-order", "5b1f2a4e-8c1d-4e0b-9a51-3f7a2d6c1e01"),
  {
    id: "a-cada-5-min", name: "A cada 5 min: pendentes", type: "n8n-nodes-base.scheduleTrigger", typeVersion: 1.2,
    position: pos(0, 1),
    parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 5 }] } },
  },
  code("Pedido do webhook", pos(1, 0), `return { json: { p_order_id: $json.body?.order_id ?? null } };`, "runOnceForEachItem"),
  code("Sweep de pendentes", pos(1, 1), `return { json: { p_order_id: null } };`, "runOnceForEachItem"),
  httpJson("Claim de pedidos", pos(2, 0), {
    url: `${SUPA}/rest/v1/rpc/claim_orders_for_review`,
    body: "={{ JSON.stringify({ p_order_id: $json.p_order_id }) }}",
    auth: supabaseAuth, creds: supabaseCreds,
  }),
  code("Montar requisições", pos(3, 0), `${buildRequestSrc}

// Uma requisição por item personalizado de cada pedido "claimado"
const out = [];
for (const { json: order } of $input.all()) {
  if (!order || !order.order_id) continue;
  for (const item of order.items ?? []) {
    out.push({ json: {
      order_id: order.order_id,
      order_number: order.order_number,
      order_item_id: item.order_item_id,
      item_count: order.items.length,
      brand_threshold: Number(order.brand_threshold),
      checks_passed: item.checks?.passed === true,
      started_at: Date.now(),
      request: buildReviewRequest({ ...item, order_date: order.order_date }),
    }});
  }
}
return out;`),
  // O provedor (Codex CLI ou Messages API) fica atrás do gateway no host: ver services/llm-gateway.ts
  httpJson("LLM: revisar item", pos(4, 0), {
    url: "={{ $env.LLM_GATEWAY_URL }}/v1/messages",
    body: "={{ JSON.stringify($json.request) }}",
    auth: { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" },
    creds: { httpHeaderAuth: CRED.llm },
    options: { timeout: 200000 },
    extra: { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: "continueRegularOutput" },
  }),
  code("Interpretar e rotear", pos(5, 0), `${reviewLogicSrc}

const reqs = $("Montar requisições").all();
const byOrder = new Map();
const failures = [];

$input.all().forEach(({ json: resp }, i) => {
  const ctx = reqs[i].json;
  // HTTP com erro (após retries) chega como { error: ... } sem "content"
  const parsed = resp && resp.error && !resp.content
    ? { ok: false, reason: "request_failed:" + (resp.error.message ?? resp.error).toString().slice(0, 120) }
    : parseReviewResponse(resp);
  const status = routeItem({ parsed, checksPassed: ctx.checks_passed, brandThreshold: ctx.brand_threshold });

  const result = parsed.ok
    ? { ...parsed.review, model: parsed.model ?? ctx.request.model }
    : { verdict: "unavailable", issues: ["AI review unavailable: please review manually"],
        suggested_text: null, customer_message: null, confidence: 0, model: ctx.request.model };
  if (!parsed.ok) failures.push({ workflow: "Revisar pedido", node: "LLM: revisar item",
    order_id: ctx.order_id, message: parsed.reason, details: { order_item_id: ctx.order_item_id } });

  const entry = byOrder.get(ctx.order_id) ?? { order_id: ctx.order_id, statuses: [], results: [] };
  entry.statuses.push(status);
  entry.results.push({ order_item_id: ctx.order_item_id, prompt_version: ${JSON.stringify(PROMPT_VERSION)},
    latency_ms: Date.now() - ctx.started_at, ...result });
  byOrder.set(ctx.order_id, entry);
});

return [...byOrder.values()].map((e) => ({ json: {
  order_id: e.order_id,
  order_status: routeOrder(e.statuses),
  results: e.results,
  failures: failures.filter((f) => f.order_id === e.order_id),
}}));`),
  httpJson("Salvar revisões", pos(6, 0), {
    url: `${SUPA}/rest/v1/rpc/save_review_results`,
    body: "={{ JSON.stringify({ p_order_id: $json.order_id, p_order_status: $json.order_status, p_results: $json.results }) }}",
    auth: supabaseAuth, creds: supabaseCreds,
    extra: { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 },
  }),
  code("Repassar contexto", pos(7, 0), `return $("Interpretar e rotear").all();`),
  ifNode("Aprovado automaticamente?", pos(8, 0), "={{ $json.order_status }}", "auto_approved"),
  httpJson("Aplicar no Shopify", pos(9, -0.5), {
    url: "={{ $env.N8N_BASE_URL }}/webhook/apply-decision",
    body: "={{ JSON.stringify({ order_id: $json.order_id }) }}",
    auth: { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" },
    creds: { httpHeaderAuth: CRED.webhook },
  }),
  ifNode("Houve falha da IA?", pos(9, 0.7), "={{ $json.failures.length > 0 }}", "true"),
  httpJson("Registrar falhas", pos(10, 0.7), {
    url: `${SUPA}/rest/v1/workflow_errors`,
    body: "={{ JSON.stringify($json.failures) }}",
    auth: supabaseAuth, creds: supabaseCreds,
  }),
];
const revisar = workflow(WF.revisar, "Revisar pedido", revisarNodes, connect([
  ["Webhook: pedido novo", "Pedido do webhook"],
  ["A cada 5 min: pendentes", "Sweep de pendentes"],
  ["Pedido do webhook", "Claim de pedidos"],
  ["Sweep de pendentes", "Claim de pedidos"],
  ["Claim de pedidos", "Montar requisições"],
  ["Montar requisições", "LLM: revisar item"],
  ["LLM: revisar item", "Interpretar e rotear"],
  ["Interpretar e rotear", "Salvar revisões"],
  ["Salvar revisões", "Repassar contexto"],
  ["Repassar contexto", "Aprovado automaticamente?"],
  ["Repassar contexto", "Houve falha da IA?"],
  ["Aprovado automaticamente?", "Aplicar no Shopify", 0],
  ["Houve falha da IA?", "Registrar falhas", 0],
]));

// ═══ 2. Aplicar decisão no Shopify ═══════════════════════════════════
const aplicarNodes = [
  webhook("Webhook: aplicar decisão", pos(0), "apply-decision", "5b1f2a4e-8c1d-4e0b-9a51-3f7a2d6c1e02"),
  httpJson("Buscar pedido", pos(1), {
    method: "GET",
    url: `=${"{{ $env.SUPABASE_URL }}"}/rest/v1/orders?id=eq.{{ $json.body.order_id }}&select=id,order_number,shopify_order_id,status,brands(shop_domain),order_items(title,reviews(verdict,created_at,review_decisions(action,final_text,created_at)))`,
    // Objeto único (406 se o pedido não existir). O n8n não reconhece esse
    // content-type como JSON e entregaria texto: o formato é forçado.
    headers: [{ name: "Accept", value: "application/vnd.pgrst.object+json" }],
    auth: supabaseAuth, creds: supabaseCreds,
    options: { response: { response: { responseFormat: "json" } } },
  }),
  code("Montar tags e nota", pos(2), `const o = $json;
const TAGS = {
  auto_approved: ["personalisation-ok", "ai-reviewed"],
  approved: ["personalisation-ok", "human-reviewed"],
  rejected: ["personalisation-hold", "human-reviewed"],
};
const tags = TAGS[o.status];
if (!tags) throw new Error("Pedido " + o.order_number + " não está decidido (status: " + o.status + ")");

const lines = [];
for (const item of o.order_items ?? []) {
  const review = (item.reviews ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const decision = (review?.review_decisions ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (decision?.action === "edit") {
    lines.push(item.title + ": produce as " + decision.final_text.map((f) => f.name + ' = "' + f.value + '"').join(", "));
  } else if (decision?.action === "reject") {
    lines.push(item.title + ": ON HOLD, contact customer");
  }
}
const note = "[Order Ops Copilot] " + (o.status === "auto_approved" ? "Personalisation auto-approved." : "Reviewed by operations.")
  + (lines.length ? "\\n" + lines.join("\\n") : "");

return { json: {
  order_id: o.id,
  shop_domain: o.brands.shop_domain,
  order_gid: "gid://shopify/Order/" + o.shopify_order_id,
  tags, note,
  mode: $env.SHOPIFY_MODE === "live" ? "live" : "mock",
}};`, "runOnceForEachItem"),
  ifNode("Shopify em modo live?", pos(3), "={{ $json.mode }}", "live"),
  httpJson("Shopify: tags + nota", pos(4, -0.5), {
    url: "=https://{{ $json.shop_domain }}/admin/api/2026-07/graphql.json",
    body: `={{ JSON.stringify({
  query: "mutation($id: ID!, $tags: [String!]!, $input: OrderInput!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } orderUpdate(input: $input) { userErrors { message } } }",
  variables: { id: $json.order_gid, tags: $json.tags, input: { id: $json.order_gid, note: $json.note } }
}) }}`,
    auth: { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" },
    creds: { httpHeaderAuth: CRED.shopify },
    extra: { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 },
  }),
  code("Simular Shopify (mock)", pos(4, 0.5), `return { json: { data: { tagsAdd: { userErrors: [] }, orderUpdate: { userErrors: [] } }, mock: true } };`, "runOnceForEachItem"),
  code("Resultado do write-back", pos(5), `const ctx = $("Montar tags e nota").item.json;
const errors = [...($json.data?.tagsAdd?.userErrors ?? []), ...($json.data?.orderUpdate?.userErrors ?? []), ...($json.errors ?? [])];
return { json: { order_id: ctx.order_id, mode: ctx.mode, tags: ctx.tags, note: ctx.note, ok: errors.length === 0, response: $json } };`, "runOnceForEachItem"),
  httpJson("Registrar sync", pos(6), {
    url: `${SUPA}/rest/v1/shopify_sync_log`,
    body: "={{ JSON.stringify($json) }}",
    auth: supabaseAuth, creds: supabaseCreds,
  }),
];
const aplicar = workflow(WF.aplicar, "Aplicar decisão no Shopify", aplicarNodes, connect([
  ["Webhook: aplicar decisão", "Buscar pedido"],
  ["Buscar pedido", "Montar tags e nota"],
  ["Montar tags e nota", "Shopify em modo live?"],
  ["Shopify em modo live?", "Shopify: tags + nota", 0],
  ["Shopify em modo live?", "Simular Shopify (mock)", 1],
  ["Shopify: tags + nota", "Resultado do write-back"],
  ["Simular Shopify (mock)", "Resultado do write-back"],
  ["Resultado do write-back", "Registrar sync"],
]));

// ═══ 3. Tratar erros ═════════════════════════════════════════════════
const errosNodes = [
  { id: "error-trigger", name: "Falha em workflow", type: "n8n-nodes-base.errorTrigger", typeVersion: 1, position: pos(0), parameters: {} },
  httpJson("Registrar erro", pos(1), {
    url: `${SUPA}/rest/v1/workflow_errors`,
    body: `={{ JSON.stringify({
  workflow: $json.workflow?.name ?? "desconhecido",
  node: $json.execution?.lastNodeExecuted ?? null,
  message: ($json.execution?.error?.message ?? "erro sem mensagem").slice(0, 1000),
  details: { execution_id: $json.execution?.id, stack: ($json.execution?.error?.stack ?? "").slice(0, 2000) },
  execution_url: $json.execution?.url ?? null
}) }}`,
    auth: supabaseAuth, creds: supabaseCreds,
  }),
];
const erros = workflow(WF.erros, "Tratar erros", errosNodes, connect([["Falha em workflow", "Registrar erro"]]), { errorWorkflow: null });

const saidas: [arquivo: string, wf: Workflow][] = [
  ["01-revisar-pedido.json", revisar],
  ["02-aplicar-decisao.json", aplicar],
  ["03-tratar-erros.json", erros],
];
for (const [file, wf] of saidas) {
  writeFileSync(join(outDir, file), JSON.stringify(wf, null, 2) + "\n");
  console.log(`n8n/workflows/${file}  (${wf.nodes.length} nós)`);
}
