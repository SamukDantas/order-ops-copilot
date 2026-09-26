// Fonte única da requisição de revisão enviada ao Claude.
// Usada pelo gerador de workflows do n8n (serializada no Code node) e pelo
// runner de avaliação, garantindo que o que é avaliado é o que roda.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PROMPT_VERSION = "personalisation-review.v1";
export const MODEL = "claude-opus-5";

export const SYSTEM_PROMPT = readFileSync(join(root, "prompts", `${PROMPT_VERSION}.md`), "utf8").trim();
export const OUTPUT_SCHEMA = JSON.parse(readFileSync(join(root, "prompts", "review-schema.json"), "utf8"));

/** Beta necessária para `fallbacks: "default"` (reexecução server-side em caso de recusa). */
export const ANTHROPIC_BETA = "server-side-fallback-2026-07-01";

/**
 * @param {{ title: string, charset: string | null, personalisation: Record<string,string>,
 *           checks: unknown, order_date: string }} item
 */
export function buildReviewRequest(item) {
  const input = {
    product: item.title,
    technique: item.charset ?? "unknown",
    order_date: item.order_date,
    personalisation: Object.entries(item.personalisation).map(([name, value]) => ({ name, value })),
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
