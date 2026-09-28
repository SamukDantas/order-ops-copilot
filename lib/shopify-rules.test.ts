import { test } from "node:test";
import assert from "node:assert/strict";
import { rulesFromProducts } from "./shopify-rules.ts";

const mf = (value: string | null) => (value === null ? null : { value });
const produto = (title: string, max: string | null, charset: string | null, variantes: { sku: string | null; max?: string | null; charset?: string | null }[]) => ({
  title, maxChars: mf(max), charset: mf(charset),
  variants: { nodes: variantes.map((v) => ({ sku: v.sku, maxChars: mf(v.max ?? null), charset: mf(v.charset ?? null) })) },
});

test("regra do produto vale para todas as variantes; a da variante sobrescreve", () => {
  const { rules, problems } = rulesFromProducts({ products: { nodes: [
    produto("Engraved Watch", "40", "engraving", [{ sku: "ENG-WATCH" }, { sku: "ENG-WATCH-XL", max: "60" }]),
  ] } });
  assert.deepEqual(problems, []);
  assert.deepEqual(rules, [
    { sku: "ENG-WATCH", max_chars: 40, charset: "engraving" },
    { sku: "ENG-WATCH-XL", max_chars: 60, charset: "engraving" },
  ]);
});

test("produto sem metafields é ignorado em silêncio", () => {
  const { rules, problems } = rulesFromProducts({ products: { nodes: [produto("Gift Card", null, null, [{ sku: "GIFT" }])] } });
  assert.deepEqual(rules, []);
  assert.deepEqual(problems, []);
});

test("regra inválida vira problema e não entra", () => {
  const { rules, problems } = rulesFromProducts({ products: { nodes: [
    produto("A", "0", "engraving", [{ sku: "A-1" }]),
    produto("B", "12.5", "print", [{ sku: "B-1" }]),
    produto("C", "20", "laser", [{ sku: "C-1" }]),
    produto("D", "20", null, [{ sku: "D-1" }]),
    produto("E", "20", "print", [{ sku: null }]),
  ] } });
  assert.deepEqual(rules, []);
  assert.equal(problems.length, 5);
  assert.match(problems.join("\n"), /A-1: max_chars/);
  assert.match(problems.join("\n"), /C-1: charset/);
  assert.match(problems.join("\n"), /E: variante com regra, mas sem SKU/);
});

test("SKU repetido: vale a primeira regra", () => {
  const { rules, problems } = rulesFromProducts({ products: { nodes: [
    produto("A", "20", "engraving", [{ sku: "X" }]),
    produto("B", "30", "print", [{ sku: "X" }]),
  ] } });
  assert.deepEqual(rules, [{ sku: "X", max_chars: 20, charset: "engraving" }]);
  assert.match(problems[0] ?? "", /X: SKU repetido/);
});

test("resposta malformada não quebra", () => {
  assert.deepEqual(rulesFromProducts(null), { rules: [], problems: [] });
  assert.deepEqual(rulesFromProducts({ products: "x" }), { rules: [], problems: [] });
});
