// Verificação do HMAC dos webhooks do Shopify.
// O Shopify assina o corpo *bruto* com HMAC-SHA256 usando o client secret
// do app e envia o resultado em base64 no header X-Shopify-Hmac-Sha256.

const encoder = new TextEncoder();

export async function signBody(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return bytesToBase64(new Uint8Array(sig));
}

export async function verifyShopifyHmac(
  rawBody: string,
  hmacHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!hmacHeader || !secret) return false;
  const expected = await signBody(rawBody, secret);
  return timingSafeEqual(expected, hmacHeader.trim());
}

/** Comparação em tempo constante (não vaza a posição da primeira diferença). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
