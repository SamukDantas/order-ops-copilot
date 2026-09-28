#!/usr/bin/env node
// Avalia o prompt atual contra o conjunto rotulado em evals/cases.json.
// Usa exatamente a mesma requisição e o mesmo provedor (LLM_PROVEDOR) do fluxo real.
//
// Uso: npm run eval [-- --only id1,id2]
// Custa uma chamada real por caso (cota do Codex ou crédito da API).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReviewRequest, PROMPT_VERSION, toFields } from "../lib/review-request.ts";
import { completar, provedor, codexModelo } from "../lib/llm-provider.ts";
import { parseReviewResponse, routeItem } from "../lib/review-logic.ts";
import { checkPersonalisation, type Charset } from "../supabase/functions/_shared/checks.ts";
import type { LlmResponse, ModelVerdict, ReviewRoute } from "../lib/types.ts";

interface EvalCase {
  id: string;
  title: string;
  charset: Charset;
  max_chars: number;
  personalisation: Record<string, string>;
  expect: ModelVerdict[];
}

interface CaseResult {
  id: string;
  expect: ModelVerdict[];
  verdict: ModelVerdict | null;
  route: ReviewRoute | null;
  checks_passed: boolean | null;
  pass: boolean;
  confidence: number | null;
  issues: string[];
  latency_ms: number;
  model: string | null;
  usage: LlmResponse["usage"];
  error?: string;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let cases: EvalCase[] = JSON.parse(readFileSync(join(root, "evals", "cases.json"), "utf8"));
const onlyIdx = process.argv.indexOf("--only");
if (onlyIdx > -1) {
  const ids = new Set((process.argv[onlyIdx + 1] ?? "").split(","));
  cases = cases.filter((c) => ids.has(c.id));
}

const ORDER_DATE = "2026-09-26";

async function runCase(c: EvalCase): Promise<CaseResult> {
  const campos = toFields(c.personalisation);
  const checks = checkPersonalisation(campos, { max_chars: c.max_chars, charset: c.charset });
  const body = buildReviewRequest({ title: c.title, charset: c.charset, personalisation: campos, checks, order_date: ORDER_DATE });
  const t0 = Date.now();
  let resp: LlmResponse;
  try {
    resp = await completar(body);
  } catch (e) {
    return {
      id: c.id, expect: c.expect, verdict: null, route: null, checks_passed: checks.passed, pass: false,
      confidence: null, issues: [], latency_ms: Date.now() - t0, model: null, usage: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const parsed = parseReviewResponse(resp);
  const verdict = parsed.ok ? parsed.review.verdict : null;
  // Rota final, como no n8n: é o que decide se o item vai para produção sem humano
  const route = routeItem({ parsed, checksPassed: checks.passed, brandThreshold: 0.85 });
  return {
    id: c.id, expect: c.expect, verdict, route, checks_passed: checks.passed,
    pass: verdict !== null && c.expect.includes(verdict),
    confidence: parsed.ok ? parsed.review.confidence : null,
    issues: parsed.ok ? parsed.review.issues : [parsed.reason],
    latency_ms: Date.now() - t0,
    model: resp.model,
    usage: resp.usage,
  };
}

// Concorrência limitada para não estourar cota ou rate limit
const results: CaseResult[] = [];
const queue = [...cases];
const PARALELO = Number(process.env.EVAL_PARALELO || (provedor() === "codex" ? 2 : 4));
console.log(`provedor: ${provedor()}${provedor() === "codex" ? ` (${codexModelo()})` : ""}`);
await Promise.all(Array.from({ length: PARALELO }, async () => {
  for (let c = queue.shift(); c; c = queue.shift()) {
    const r = await runCase(c);
    results.push(r);
    process.stdout.write(
      `${r.pass ? "✓" : "✗"} ${r.id.padEnd(28)} esperado ${r.expect.join("|").padEnd(10)} ` +
      `obtido ${String(r.verdict).padEnd(8)} ${String(r.confidence ?? "").padEnd(5)} → ${r.route ?? r.error}\n`,
    );
  }
}));

// Métricas de "sinalização" (flag = qualquer coisa diferente de ok): é o que decide ir para humano
const isFlag = (v: ModelVerdict | null): boolean => v !== "ok";
const scored = results.filter((r) => r.verdict !== null);
const tp = scored.filter((r) => isFlag(r.verdict) && !r.expect.includes("ok")).length;
const fp = scored.filter((r) => isFlag(r.verdict) && r.expect.includes("ok")).length;
const fn = scored.filter((r) => !isFlag(r.verdict) && !r.expect.includes("ok")).length;
const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "n/a");

const summary = {
  prompt_version: PROMPT_VERSION,
  provider: provedor(),
  model: results.find((r) => r.model)?.model ?? null,
  cases: results.length,
  exact_accuracy: results.filter((r) => r.pass).length / results.length,
  flag_precision: tp / (tp + fp),
  flag_recall: tp / (tp + fn),
  failures: results.filter((r) => r.verdict === null).length,
  // Métrica de segurança: item que deveria ir para humano e seria aprovado sozinho
  unsafe_auto_approvals: results.filter((r) => r.route === "auto_approved" && !r.expect.includes("ok")).map((r) => r.id),
  // Custo operacional: item bom que iria para humano sem necessidade
  unneeded_reviews: results.filter((r) => r.route !== "auto_approved" && r.expect.includes("ok")).map((r) => r.id),
  input_tokens: results.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0),
  output_tokens: results.reduce((s, r) => s + (r.usage?.output_tokens ?? 0), 0),
};

const lista = (ids: string[]): string => (ids.length ? ` → ${ids.join(", ")}` : "");
console.log(`\n${PROMPT_VERSION}: acerto exato ${pct(summary.exact_accuracy)} · precisão da sinalização ${pct(summary.flag_precision)} · recall ${pct(summary.flag_recall)} · falhas ${summary.failures}`);
console.log(`rota final: ${summary.unsafe_auto_approvals.length} aprovação(ões) automática(s) indevida(s)${lista(summary.unsafe_auto_approvals)} · ${summary.unneeded_reviews.length} revisão(ões) humana(s) desnecessária(s)${lista(summary.unneeded_reviews)}`);
console.log(`tokens: ${summary.input_tokens} entrada / ${summary.output_tokens} saída`);

mkdirSync(join(root, "evals", "results"), { recursive: true });
const file = join(root, "evals", "results", `${PROMPT_VERSION}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
console.log(`resultado salvo em ${file}`);
process.exitCode = summary.flag_recall < 1 || summary.failures > 0 || summary.unsafe_auto_approvals.length > 0 ? 1 : 0;
