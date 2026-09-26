#!/usr/bin/env node
// Gateway de LLM para o n8n.
//
// O n8n roda em container; o provedor padrão (Codex CLI com o login da conta
// ChatGPT) roda no host. O gateway é a porta entre os dois: recebe a mesma
// requisição que o workflow montaria para a Messages API e responde no mesmo
// formato, qualquer que seja o provedor (LLM_PROVEDOR). Trocar de provedor é
// mudar uma variável; o workflow não muda.
//
//   POST /v1/messages   header x-gateway-secret   body = buildReviewRequest(...)
//   GET  /health
//
// Uso: npm run gateway

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { completar, provedor, codexModelo } from "../lib/llm-provider.mjs";

const PORTA = Number(process.env.LLM_GATEWAY_PORT || 8787);
const HOST = process.env.LLM_GATEWAY_HOST || "0.0.0.0";
const SEGREDO = process.env.LLM_GATEWAY_SECRET || "";
// O Codex é um processo por chamada; paralelismo alto só enfileira no servidor
// e queima cota em rajada. Excedente espera aqui, com teto de fila.
const PARALELO = Number(process.env.LLM_GATEWAY_PARALELO || 2);
const FILA_MAX = 50;

if (!SEGREDO) {
  console.error("LLM_GATEWAY_SECRET não definido (rode npm run setup).");
  process.exit(1);
}

let ativos = 0;
const fila = [];
const liberar = () => { ativos--; fila.shift()?.(); };
const ocupar = () => new Promise((ok) => {
  if (ativos < PARALELO) { ativos++; ok(); } else fila.push(() => { ativos++; ok(); });
});

const segredoOk = (valor) => {
  const a = Buffer.from(String(valor ?? ""));
  const b = Buffer.from(SEGREDO);
  return a.length === b.length && timingSafeEqual(a, b);
};

const responder = (res, status, corpo) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(corpo));
};
const erro = (res, status, tipo, mensagem) => responder(res, status, { type: "error", error: { type: tipo, message: mensagem } });

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return responder(res, 200, { ok: true, provider: provedor(), ativos, fila: fila.length });
  }
  if (req.method !== "POST" || req.url !== "/v1/messages") return erro(res, 404, "not_found", "rota inexistente");
  if (!segredoOk(req.headers["x-gateway-secret"])) return erro(res, 401, "authentication_error", "segredo inválido");
  if (fila.length >= FILA_MAX) return erro(res, 429, "rate_limit_error", "fila do gateway cheia");

  let corpo = "";
  for await (const parte of req) {
    corpo += parte;
    if (corpo.length > 1_000_000) return erro(res, 413, "invalid_request_error", "corpo grande demais");
  }
  let request;
  try {
    request = JSON.parse(corpo);
  } catch {
    return erro(res, 400, "invalid_request_error", "JSON inválido");
  }

  await ocupar();
  const t0 = Date.now();
  try {
    const resposta = await completar(request);
    console.log(`200 ${resposta.model} ${Date.now() - t0}ms`);
    responder(res, 200, resposta);
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 500);
    console.warn(`502 ${Date.now() - t0}ms ${msg}`);
    erro(res, 502, "provider_error", msg);
  } finally {
    liberar();
  }
}).listen(PORTA, HOST, () => {
  const detalhe = provedor() === "codex" ? ` (${codexModelo()})` : "";
  console.log(`LLM gateway em http://${HOST}:${PORTA} · provedor ${provedor()}${detalhe} · paralelo ${PARALELO}`);
});
