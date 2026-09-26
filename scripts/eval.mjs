#!/usr/bin/env node
// Avalia o prompt atual contra o conjunto rotulado em evals/cases.json.
// Usa exatamente a mesma requisição que o workflow do n8n (lib/review-request.mjs).
//
// Uso: npm run eval [-- --only id1,id2]
// Custa chamadas reais à API: ~1 requisição por caso.

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReviewRequest, ANTHROPIC_BETA, PROMPT_VERSION } from "../lib/review-request.mjs";
import { parseReviewResponse } from "../lib/review-logic.mjs";
import { checkPersonalisation } from "../supabase/functions/_shared/checks.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let cases = JSON.parse(readFileSync(join(root, "evals", "cases.json"), "utf8"));
const onlyIdx = process.argv.indexOf("--only");
if (onlyIdx > -1) {
  const ids = new Set(process.argv[onlyIdx + 1].split(","));
  cases = cases.filter((c) => ids.has(c.id));
}

const client = new Anthropic();
const ORDER_DATE = "2026-09-26";

async function runCase(c) {
  const checks = checkPersonalisation(c.personalisation, { max_chars: c.max_chars, charset: c.charset });
  const body = buildReviewRequest({ title: c.title, charset: c.charset, personalisation: c.personalisation, checks, order_date: ORDER_DATE });
  const t0 = Date.now();
  let resp;
  try {
    resp = await client.beta.messages.create({ ...body, betas: [ANTHROPIC_BETA] });
  } catch (e) {
    return { id: c.id, expect: c.expect, verdict: null, pass: false, error: e.message ?? String(e) };
  }
  const parsed = parseReviewResponse(resp);
  const verdict = parsed.ok ? parsed.review.verdict : null;
  return {
    id: c.id, expect: c.expect, verdict,
    pass: verdict !== null && c.expect.includes(verdict),
    confidence: parsed.ok ? parsed.review.confidence : null,
    issues: parsed.ok ? parsed.review.issues : [parsed.reason],
    latency_ms: Date.now() - t0,
    usage: resp.usage,
  };
}

// Concorrência limitada para não estourar rate limit
const results = [];
const queue = [...cases];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const c = queue.shift();
    const r = await runCase(c);
    results.push(r);
    process.stdout.write(`${r.pass ? "✓" : "✗"} ${r.id.padEnd(28)} esperado ${r.expect.join("|").padEnd(10)} obtido ${String(r.verdict).padEnd(8)} ${r.confidence ?? ""}\n`);
  }
}));

// Métricas de "sinalização" (flag = qualquer coisa diferente de ok): é o que decide ir para humano
const isFlag = (v) => v !== "ok";
const scored = results.filter((r) => r.verdict !== null);
const tp = scored.filter((r) => isFlag(r.verdict) && !r.expect.includes("ok")).length;
const fp = scored.filter((r) => isFlag(r.verdict) && r.expect.includes("ok")).length;
const fn = scored.filter((r) => !isFlag(r.verdict) && !r.expect.includes("ok")).length;
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(0) + "%" : "n/a");

const summary = {
  prompt_version: PROMPT_VERSION,
  cases: results.length,
  exact_accuracy: results.filter((r) => r.pass).length / results.length,
  flag_precision: tp / (tp + fp),
  flag_recall: tp / (tp + fn),
  failures: results.filter((r) => r.verdict === null).length,
  input_tokens: results.reduce((s, r) => s + (r.usage?.input_tokens ?? 0), 0),
  output_tokens: results.reduce((s, r) => s + (r.usage?.output_tokens ?? 0), 0),
};
console.log(`\n${PROMPT_VERSION}: acerto exato ${pct(summary.exact_accuracy)} · precisão da sinalização ${pct(summary.flag_precision)} · recall ${pct(summary.flag_recall)} · falhas ${summary.failures}`);
console.log(`tokens: ${summary.input_tokens} entrada / ${summary.output_tokens} saída`);

mkdirSync(join(root, "evals", "results"), { recursive: true });
const file = join(root, "evals", "results", `${PROMPT_VERSION}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
console.log(`resultado salvo em ${file}`);
process.exitCode = summary.flag_recall < 1 || summary.failures > 0 ? 1 : 0;
