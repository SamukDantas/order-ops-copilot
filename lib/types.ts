// Contratos compartilhados entre o workflow do n8n, o gateway de LLM, o eval e os testes.

import type { ChecksResult, Charset } from "../supabase/functions/_shared/checks.ts";

export type { ChecksResult, Charset };

/** Um campo de personalização, na ordem em que o cliente o preencheu. */
export interface Field {
  name: string;
  value: string;
}

/** Veredito que o modelo pode dar (o schema de saída restringe a estes três). */
export type ModelVerdict = "ok" | "fix" | "reject";

/** Rota final de um item ou pedido depois da revisão. */
export type ReviewRoute = "auto_approved" | "needs_review";

/** O que é revisado: um item de pedido com a personalização e as verificações determinísticas. */
export interface ReviewItemInput {
  title: string;
  charset: Charset | string | null;
  /** Lista na ordem do cliente; um objeto (formato anterior) é aceito e convertido. */
  personalisation: Field[] | Record<string, string>;
  checks: ChecksResult | Record<string, unknown>;
  order_date: string;
}

// ─── Requisição e resposta no molde da Messages API ──────────────────
// É o contrato interno: o gateway recebe uma ReviewRequest e responde uma
// LlmResponse, qualquer que seja o provedor.

export interface ReviewRequest {
  model: string;
  max_tokens: number;
  fallbacks: "default";
  thinking: { type: "adaptive" };
  output_config: {
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    format: { type: "json_schema"; schema: JsonSchema };
  };
  system: string;
  messages: { role: "user" | "assistant"; content: string | { type: string; text?: string }[] }[];
}

export type JsonSchema = Record<string, unknown>;

export interface ContentBlock {
  type: string;
  text?: string;
}

export interface LlmResponse {
  type: "message";
  model: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  content: ContentBlock[];
  usage: { input_tokens: number; output_tokens: number } | null;
}

export interface LlmError {
  type: "error";
  error: { type: string; message?: string };
}

// ─── Resultado interpretado ──────────────────────────────────────────

export interface Review {
  verdict: ModelVerdict;
  issues: string[];
  suggested_text: Field[] | null;
  confidence: number;
  customer_message: string | null;
}

export type ParsedReview =
  | { ok: true; review: Review; model: string | null }
  | { ok: false; reason: string };
