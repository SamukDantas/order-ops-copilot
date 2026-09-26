// Lógica pura de interpretação da resposta do Claude e de roteamento.
// Sem imports: o gerador de workflows injeta estas funções no Code node do n8n.

const VERDICTS = ["ok", "fix", "reject"];
export const MIN_CONFIDENCE_FOR_TRUST = 0.7;

/**
 * Converte a resposta da Messages API numa revisão validada.
 * Nunca lança: qualquer problema vira { ok: false, reason } e o item vai para humano.
 */
export function parseReviewResponse(resp) {
  if (!resp || typeof resp !== "object") return { ok: false, reason: "empty_response" };
  if (resp.type === "error") return { ok: false, reason: `api_error:${resp.error?.type ?? "unknown"}` };
  if (resp.stop_reason === "refusal") return { ok: false, reason: `refusal:${resp.stop_details?.category ?? "unknown"}` };
  if (resp.stop_reason === "max_tokens") return { ok: false, reason: "max_tokens" };

  const text = (resp.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  if (!VERDICTS.includes(data.verdict)) return { ok: false, reason: "invalid_verdict" };
  if (!Array.isArray(data.issues) || !data.issues.every((i) => typeof i === "string")) {
    return { ok: false, reason: "invalid_issues" };
  }
  const confidence = Number(data.confidence);
  if (!Number.isFinite(confidence)) return { ok: false, reason: "invalid_confidence" };

  let suggested = null;
  if (Array.isArray(data.suggested_text)) {
    suggested = data.suggested_text
      .filter((f) => f && typeof f.name === "string" && typeof f.value === "string")
      .map((f) => ({ name: f.name, value: f.value }));
  }
  if (data.verdict === "fix" && (!suggested || suggested.length === 0)) {
    return { ok: false, reason: "fix_without_suggestion" };
  }

  return {
    ok: true,
    review: {
      verdict: data.verdict,
      issues: data.issues,
      suggested_text: data.verdict === "fix" ? suggested : null,
      confidence: Math.min(1, Math.max(0, Math.round(confidence * 100) / 100)),
      customer_message: typeof data.customer_message === "string" ? data.customer_message : null,
    },
    model: resp.model ?? null,
  };
}

/**
 * Decide o status do item. Só aprova automaticamente quando TUDO concorda:
 * verificações determinísticas passaram, a IA disse "ok" e a confiança
 * atinge o limiar da marca.
 */
export function routeItem({ parsed, checksPassed, brandThreshold }) {
  if (!parsed.ok) return "needs_review";
  const { verdict, confidence } = parsed.review;
  if (!checksPassed) return "needs_review";
  if (verdict !== "ok") return "needs_review";
  if (confidence < Math.max(brandThreshold, MIN_CONFIDENCE_FOR_TRUST)) return "needs_review";
  return "auto_approved";
}

/** Status do pedido a partir dos itens: um item com problema segura o pedido inteiro. */
export function routeOrder(itemStatuses) {
  if (itemStatuses.length === 0) return "needs_review";
  return itemStatuses.every((s) => s === "auto_approved") ? "auto_approved" : "needs_review";
}
