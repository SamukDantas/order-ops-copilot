// Fonte única da requisição de revisão.
// Usada pelo gerador de workflows do n8n (serializada no Code node) e pelo
// runner de avaliação, garantindo que o que é avaliado é o que roda.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Field, JsonSchema, ReviewItemInput, ReviewRequest } from "./types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PROMPT_VERSION = "personalisation-review.v2";
/** Modelo pedido quando o provedor é a Messages API; o Codex usa CODEX_RUN_MODEL. */
export const MODEL = "claude-opus-5";

export const SYSTEM_PROMPT: string = readFileSync(join(root, "prompts", `${PROMPT_VERSION}.md`), "utf8").trim();
export const OUTPUT_SCHEMA: JsonSchema = JSON.parse(readFileSync(join(root, "prompts", "review-schema.json"), "utf8"));

/** Beta necessária para `fallbacks: "default"` (reexecução server-side em caso de recusa). */
export const ANTHROPIC_BETA = "server-side-fallback-2026-07-01";

/**
 * Normaliza a personalização para a lista `{name, value}` na ordem do cliente.
 * Aceita o objeto do formato anterior (linhas gravadas antes da migration que
 * trocou o tipo) para a troca não ter janela quebrada; entradas malformadas
 * são descartadas.
 */
export function toFields(x: unknown): Field[] {
  if (Array.isArray(x)) {
    return x.flatMap((f: unknown) => {
      if (typeof f !== "object" || f === null) return [];
      const { name, value } = f as Record<string, unknown>;
      return typeof name === "string" ? [{ name, value: typeof value === "string" ? value : String(value ?? "") }] : [];
    });
  }
  if (typeof x === "object" && x !== null) {
    return Object.entries(x as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value ?? "") }));
  }
  return [];
}

export function buildReviewRequest(item: ReviewItemInput): ReviewRequest {
  const input = {
    product: item.title,
    technique: item.charset ?? "unknown",
    order_date: item.order_date,
    personalisation: toFields(item.personalisation),
    deterministic_checks: item.checks,
  };
  return {
    model: MODEL,
    max_tokens: 2048,
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Review this order item.\n\n<order_item>\n${JSON.stringify(input, null, 2)}\n</order_item>`,
      },
    ],
  };
}
