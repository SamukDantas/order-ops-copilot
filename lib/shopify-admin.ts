// Cliente mínimo da Admin API do Shopify para a loja de desenvolvimento real.
//
// Autenticação por *client credentials grant*: o app (Dev Dashboard) e a loja
// pertencem à mesma organização, então o token sai direto do client ID +
// client secret, sem OAuth interativo. O token vale 24 h; quem chama pede um
// novo quando precisa (o n8n faz o mesmo antes de cada write-back).
//
// Tudo que vem da rede entra como `unknown` e é validado antes de usar.

export const API_VERSION = "2026-07";

export interface Credenciais {
  loja: string; // ex.: order-ops-copilot-demo.myshopify.com
  clientId: string;
  clientSecret: string;
}

export interface Token {
  accessToken: string;
  escopos: string[];
  expiraEm: Date;
}

const ehObjeto = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

/** Aceita só domínios *.myshopify.com, para o secret nunca ir para outro host. */
export function validarLoja(loja: string): string {
  const d = loja.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(d)) throw new Error(`domínio de loja inválido: ${loja}`);
  return d;
}

export function credenciaisDoAmbiente(env: NodeJS.ProcessEnv = process.env): Credenciais {
  const faltando = ["SHOPIFY_STORE_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"].filter((k) => !env[k]);
  if (faltando.length) throw new Error(`defina no .env: ${faltando.join(", ")}`);
  return {
    loja: validarLoja(env.SHOPIFY_STORE_DOMAIN!),
    clientId: env.SHOPIFY_CLIENT_ID!,
    clientSecret: env.SHOPIFY_CLIENT_SECRET!,
  };
}

export async function obterToken(c: Credenciais): Promise<Token> {
  const res = await fetch(`https://${validarLoja(c.loja)}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.clientId, client_secret: c.clientSecret }),
  });
  const corpo: unknown = await res.json().catch(() => null);
  if (!res.ok || !ehObjeto(corpo) || typeof corpo.access_token !== "string") {
    const detalhe = ehObjeto(corpo) ? (corpo.error_description ?? corpo.error ?? corpo.errors) : null;
    throw new Error(`token recusado pelo Shopify (${res.status})${detalhe ? `: ${String(detalhe)}` : ""}`);
  }
  const segundos = typeof corpo.expires_in === "number" ? corpo.expires_in : 0;
  return {
    accessToken: corpo.access_token,
    escopos: typeof corpo.scope === "string" ? corpo.scope.split(",").filter(Boolean) : [],
    expiraEm: new Date(Date.now() + segundos * 1000),
  };
}

export class ErroGraphql extends Error {
  readonly erros: unknown;
  constructor(mensagem: string, erros: unknown) {
    super(mensagem);
    this.erros = erros;
  }
}

/** Executa uma operação GraphQL; falha em erro HTTP, `errors` de topo ou `userErrors`. */
export async function graphql(loja: string, token: string, query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await fetch(`https://${validarLoja(loja)}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const corpo: unknown = await res.json().catch(() => null);
  if (!res.ok || !ehObjeto(corpo)) throw new ErroGraphql(`Admin API respondeu ${res.status}`, corpo);
  if (Array.isArray(corpo.errors) && corpo.errors.length) {
    throw new ErroGraphql(`Admin API: ${corpo.errors.map((e) => (ehObjeto(e) ? e.message : e)).join("; ")}`, corpo.errors);
  }
  if (!ehObjeto(corpo.data)) throw new ErroGraphql("Admin API sem `data`", corpo);

  const userErrors = Object.values(corpo.data).flatMap((v) => (ehObjeto(v) && Array.isArray(v.userErrors) ? v.userErrors : []));
  if (userErrors.length) {
    throw new ErroGraphql(`Admin API: ${userErrors.map((e) => (ehObjeto(e) ? `${e.field ?? ""} ${e.message}` : e)).join("; ")}`, userErrors);
  }
  return corpo.data;
}
