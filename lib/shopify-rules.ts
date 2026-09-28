// Regras por produto a partir dos metafields da loja (fonte única: usada pelo
// workflow de sincronização do n8n, embutida no Code node, e pelos testes).
//
// Metafields (namespace order_ops), no produto e, opcionalmente, na variante:
//   max_chars  number_integer                 limite de caracteres por campo
//   charset    single_line_text_field         engraving | print | embroidery
// A variante sobrescreve o produto. A regra é por SKU, como a tabela product_rules.

export const RULES_NAMESPACE = "order_ops";

/** Consulta da Admin API: produtos com as variantes (SKU) e os metafields das regras. */
export const PRODUCT_RULES_QUERY = `{
  products(first: 100) {
    nodes {
      title
      maxChars: metafield(namespace: "order_ops", key: "max_chars") { value }
      charset: metafield(namespace: "order_ops", key: "charset") { value }
      variants(first: 50) {
        nodes {
          sku
          maxChars: metafield(namespace: "order_ops", key: "max_chars") { value }
          charset: metafield(namespace: "order_ops", key: "charset") { value }
        }
      }
    }
  }
}`;

export interface SyncedRule {
  sku: string;
  max_chars: number;
  charset: "engraving" | "print" | "embroidery";
}

/**
 * Converte a resposta de PRODUCT_RULES_QUERY (`data`, validado como unknown) em
 * regras por SKU. Produtos sem regra são ignorados em silêncio; regra
 * incompleta ou inválida vira um problema (a variante fica sem regra, e o
 * pedido cai só nas verificações genéricas). Autocontida: roda no Code node.
 */
export function rulesFromProducts(data: unknown): { rules: SyncedRule[]; problems: string[] } {
  const obj = (x: unknown): Record<string, unknown> => (typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {});
  const lista = (x: unknown): unknown[] => (Array.isArray(obj(x).nodes) ? (obj(x).nodes as unknown[]) : []);
  const valor = (x: unknown): string | null => {
    const v = obj(x).value;
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  const CHARSETS = ["engraving", "print", "embroidery"];

  const rules: SyncedRule[] = [];
  const problems: string[] = [];
  const vistos = new Set<string>();

  for (const produto of lista(obj(data).products)) {
    const p = obj(produto);
    const titulo = typeof p.title === "string" ? p.title : "(sem título)";
    for (const variante of lista(p.variants)) {
      const v = obj(variante);
      const sku = typeof v.sku === "string" ? v.sku.trim() : "";
      const maxBruto = valor(v.maxChars) ?? valor(p.maxChars);
      const charset = valor(v.charset) ?? valor(p.charset);
      if (maxBruto === null && charset === null) continue; // produto sem personalização

      if (!sku) { problems.push(`${titulo}: variante com regra, mas sem SKU`); continue; }
      const maxChars = Number(maxBruto);
      if (maxBruto === null || !Number.isInteger(maxChars) || maxChars <= 0) {
        problems.push(`${sku}: max_chars ausente ou inválido (${maxBruto ?? "vazio"})`); continue;
      }
      if (charset === null || !CHARSETS.includes(charset)) {
        problems.push(`${sku}: charset ausente ou inválido (${charset ?? "vazio"})`); continue;
      }
      if (vistos.has(sku)) { problems.push(`${sku}: SKU repetido; vale a primeira regra`); continue; }
      vistos.add(sku);
      rules.push({ sku, max_chars: maxChars, charset: charset as SyncedRule["charset"] });
    }
  }
  return { rules, problems };
}
