#!/usr/bin/env node
// Captura as telas do dashboard para o README (docs/screenshots/).
// Pré-requisitos: dashboard em http://localhost:3000 (npm run web), usuários demo
// e pedidos revisados. Usa o Edge instalado (channel msedge): não baixa navegador.

import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { DEMO_PASSWORD } from "./demo-config.ts";

const BASE = process.env.DASHBOARD_URL || "http://localhost:3000";
const OUT = "docs/screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "msedge" });

async function sessao(email: string, colorScheme: "light" | "dark") {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', DEMO_PASSWORD);
  await Promise.all([page.waitForURL(`${BASE}/`), page.click("button")]);
  return { ctx, page };
}

async function pedido(page: Page, numero: string): Promise<void> {
  await page.goto(`${BASE}/?tab=review`);
  let link = page.getByRole("link", { name: numero, exact: true });
  if (!(await link.count())) {
    await page.goto(`${BASE}/?tab=decided`);
    link = page.getByRole("link", { name: numero, exact: true });
  }
  await link.click();
  await page.waitForURL(/\/orders\//);
}

const { ctx, page } = await sessao("ops@demo.test", "light");
await page.goto(`${BASE}/?tab=review`);
await page.screenshot({ path: `${OUT}/queue.png` });

await pedido(page, "#1044");
await page.screenshot({ path: `${OUT}/order-suggestion.png`, fullPage: true });

await pedido(page, "#1048");
await page.screenshot({ path: `${OUT}/order-prompt-injection.png`, fullPage: true });

await pedido(page, "#1042");
await page.screenshot({ path: `${OUT}/order-decided.png`, fullPage: true });
await ctx.close();

const escuro = await sessao("reviewer@demo.test", "dark");
await escuro.page.goto(`${BASE}/?tab=review`);
await escuro.page.screenshot({ path: `${OUT}/queue-dark-single-brand.png` });
await escuro.ctx.close();

await browser.close();
console.log("✓ telas salvas em docs/screenshots/");
