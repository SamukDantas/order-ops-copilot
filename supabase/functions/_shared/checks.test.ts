import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkPersonalisation } from "./checks.ts";
import { signBody, verifyShopifyHmac } from "./hmac.ts";
import { extractPersonalisation } from "./shopify.ts";

const engraving = { max_chars: 20, charset: "engraving" as const };
const embroidery = { max_chars: 12, charset: "embroidery" as const };

Deno.test("texto limpo passa", () => {
  const r = checkPersonalisation({ Name: "Olivia & Tom" }, engraving);
  assert(r.passed);
  assertEquals(r.fields[0].length, 12);
});

Deno.test("acentos contam como um caractere e são permitidos", () => {
  const r = checkPersonalisation({ Name: "Zoë Brontë" }, engraving);
  assert(r.passed);
  assertEquals(r.fields[0].length, 10);
});

Deno.test("acima do limite", () => {
  const r = checkPersonalisation({ Line1: "Happy 40th Birthday Dad!" }, engraving);
  assertEquals(r.fields[0].violations, ["over_limit"]);
});

Deno.test("emoji com seletor de variação é reportado só como emoji", () => {
  const r = checkPersonalisation({ Name: "Mia ❤️" }, embroidery);
  assertEquals(r.fields[0].violations, ["emoji"]);
});

Deno.test("emoji com tom de pele e ZWJ", () => {
  const r = checkPersonalisation({ Name: "Dad 👨🏽‍🍳" }, engraving);
  assertEquals(r.fields[0].violations, ["emoji"]);
});

Deno.test("caractere não suportado no bordado", () => {
  const r = checkPersonalisation({ Name: "Leo #1" }, embroidery);
  assertEquals(r.fields[0].violations, ["unsupported_chars"]);
  assertEquals(r.fields[0].unsupported, ["#"]);
});

Deno.test("espaços duplicados e vazio", () => {
  const r = checkPersonalisation({ A: "Mum  & Dad", B: "   " }, engraving);
  assertEquals(r.fields[0].violations, ["whitespace"]);
  assert(r.fields[1].violations.includes("empty"));
});

Deno.test("sem regra de produto: só verificações genéricas", () => {
  const r = checkPersonalisation({ Name: "A very very very long personalised text" }, null);
  assert(r.passed);
  assertEquals(r.has_rule, false);
});

Deno.test("propriedades internas (_) são ignoradas", () => {
  const f = extractPersonalisation({
    id: 1, sku: "X", title: "T", quantity: 1,
    properties: [{ name: "Name", value: "Ana" }, { name: "_upload_id", value: "abc" }],
  });
  assertEquals(f, { Name: "Ana" });
});

Deno.test("HMAC válido e inválido", async () => {
  const body = '{"id":1}';
  const sig = await signBody(body, "segredo");
  assert(await verifyShopifyHmac(body, sig, "segredo"));
  assert(!(await verifyShopifyHmac(body + " ", sig, "segredo")));
  assert(!(await verifyShopifyHmac(body, sig, "outro")));
  assert(!(await verifyShopifyHmac(body, null, "segredo")));
});
