// Tipos mínimos do payload orders/create do Shopify e extração da personalização.

import type { PersonalisationField } from "./checks.ts";

export interface ShopifyLineItem {
  id: number;
  sku: string | null;
  title: string;
  quantity: number;
  properties?: { name: string; value: string }[] | null;
}

export interface ShopifyOrder {
  id: number;
  name: string; // "#1042"
  currency: string;
  total_price: string;
  customer?: { first_name?: string | null } | null;
  line_items: ShopifyLineItem[];
}

/**
 * Retorna só as propriedades visíveis ao cliente, na ordem em que vieram do
 * Shopify (a ordem do formulário da loja). Propriedades cujo nome começa com
 * "_" são internas (apps, tracking) e não fazem parte da personalização.
 */
export function extractPersonalisation(item: ShopifyLineItem): PersonalisationField[] {
  const out: PersonalisationField[] = [];
  for (const p of item.properties ?? []) {
    if (!p?.name || p.name.startsWith("_")) continue;
    out.push({ name: p.name, value: String(p.value ?? "") });
  }
  return out;
}

export function isShopifyOrder(x: unknown): x is ShopifyOrder {
  const o = x as ShopifyOrder;
  return !!o && typeof o.id === "number" && typeof o.name === "string" && Array.isArray(o.line_items);
}
