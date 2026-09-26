import "server-only";

/**
 * Pede ao n8n que aplique a decisão no Shopify (tags + nota).
 * Falha aqui não desfaz a decisão: ela já está gravada, e o erro fica
 * visível para reenvio.
 */
export async function requestShopifyWriteBack(orderId: string): Promise<{ ok: boolean; error?: string }> {
  const base = process.env.N8N_BASE_URL;
  const secret = process.env.N8N_WEBHOOK_SECRET;
  if (!base || !secret) return { ok: false, error: "n8n não configurado" };

  try {
    const res = await fetch(`${base}/webhook/apply-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-secret": secret },
      body: JSON.stringify({ order_id: orderId }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `n8n respondeu ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
