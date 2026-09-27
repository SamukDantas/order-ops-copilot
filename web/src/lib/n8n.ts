import "server-only";

/**
 * Pede ao n8n que aplique a decisão no Shopify (tags + nota).
 * Falha aqui não desfaz a decisão: ela já está gravada, e o erro fica
 * visível para reenvio.
 */
export type WriteBackResult =
  | { status: "sent" }
  | { status: "disabled" } // demo online: sem n8n, a decisão só é gravada
  | { status: "failed"; error: string };

export async function requestShopifyWriteBack(orderId: string): Promise<WriteBackResult> {
  const base = process.env.N8N_BASE_URL;
  const secret = process.env.N8N_WEBHOOK_SECRET;
  if (!base || !secret) return { status: "disabled" };

  try {
    const res = await fetch(`${base}/webhook/apply-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-secret": secret },
      body: JSON.stringify({ order_id: orderId }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? { status: "sent" } : { status: "failed", error: `n8n respondeu ${res.status}` };
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}
