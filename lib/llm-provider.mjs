// Provedor de LLM da revisão, escolhido por LLM_PROVEDOR:
//
// - `codex` (padrão): Codex CLI headless (`codex exec`) com o login da conta
//   ChatGPT. Mesma metodologia do squad-engenharia (adaptadores/codex_cli.py):
//   sandbox read-only num diretório vazio, sem config/rules da máquina,
//   efêmero, saída em JSONL; o pedido vai pelo stdin (no Windows, argumento
//   multilinha é truncado pelo shim do npm) e `turn.failed` é falha mesmo com
//   exit 0. O schema de saída é imposto com --output-schema.
// - `anthropic`: Messages API pelo SDK oficial (exige ANTHROPIC_API_KEY com crédito).
//
// Os dois devolvem o mesmo formato mínimo, no molde da Messages API
// ({ type, model, stop_reason, content: [{type:"text", text}], usage }), que é o
// contrato que parseReviewResponse() já entende. Quem consome não sabe qual
// provedor respondeu, a não ser pelo campo `model`.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const PROVEDORES = ["codex", "anthropic"];

export function provedor() {
  const valor = (process.env.LLM_PROVEDOR || "codex").trim().toLowerCase();
  if (!PROVEDORES.includes(valor)) throw new Error(`LLM_PROVEDOR inválido: '${valor}'. Use ${PROVEDORES.join(" ou ")}.`);
  return valor;
}

export async function completar(request) {
  return provedor() === "anthropic" ? viaAnthropic(request) : viaCodex(request);
}

// ─── Anthropic ───────────────────────────────────────────────────────
async function viaAnthropic(request) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const { ANTHROPIC_BETA } = await import("./review-request.mjs");
  return new Anthropic().beta.messages.create({ ...request, betas: [ANTHROPIC_BETA] });
}

// ─── Codex ───────────────────────────────────────────────────────────
// Revisão de personalização é tarefa curta e de volume: o Luna é o modelo
// indicado para isso em docs/MODELOS-CODEX.md do squad-engenharia (e o de
// maior cota no Plus). O reserva entra quando o principal é recusado por
// plano, limite ou indisponibilidade.
export const CODEX_MODELO_PADRAO = "gpt-5.6-luna";
export const CODEX_RESERVA_PADRAO = "gpt-5.6-terra";
const SANDBOX_WINDOWS_PADRAO = "unelevated";

const PROMPT_TEXTO =
  "Responda à solicitação que está no contexto fornecido pela entrada padrão. " +
  "Não leia arquivos nem execute comandos: responda apenas com o JSON pedido.";

const RECUSAS_DO_MODELO = [
  "not supported", "usage limit", "rate limit", "too many requests", "429",
  "quota", "model_not_found", "does not exist", "unsupported model",
  "model is not available", "capacity",
];

export function codexModelo() {
  return (process.env.CODEX_RUN_MODEL || "").trim() || CODEX_MODELO_PADRAO;
}

export function codexReserva() {
  const valor = process.env.CODEX_FALLBACK_MODEL;
  const reserva = valor === undefined ? CODEX_RESERVA_PADRAO : valor.trim();
  if (!reserva || reserva.toLowerCase() === "nenhum" || reserva === codexModelo()) return null;
  return reserva;
}

/** Mensagens viram um texto só, com o papel marcado (o Codex recebe um pedido, não uma conversa). */
export function achatar(request) {
  const partes = [`[SYSTEM]\n${request.system}`];
  for (const m of request.messages) {
    const conteudo = typeof m.content === "string"
      ? m.content
      : m.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    partes.push(`[${m.role.toUpperCase()}]\n${conteudo}`);
  }
  return partes.join("\n\n");
}

/** Lê o JSONL do `codex exec --json`: mensagens do agente, uso e motivo de falha. */
export function lerStream(saida) {
  const mensagens = [];
  const falhas = [];
  const avisos = [];
  let concluiu = false;
  let usage = null;
  for (const bruta of saida.split(/\r?\n/)) {
    const linha = bruta.trim();
    if (!linha.startsWith("{")) continue;
    let ev;
    try { ev = JSON.parse(linha); } catch { continue; }
    if (ev.type === "item.completed" && ev.item?.type === "agent_message") mensagens.push(String(ev.item.text ?? "").trim());
    else if (ev.type === "turn.failed") falhas.push(String(ev.error?.message ?? "turn.failed"));
    else if (ev.type === "error") avisos.push(String(ev.message ?? "error"));
    else if (ev.type === "turn.completed") { concluiu = true; usage = ev.usage ?? null; }
  }
  // `error` seguido de `turn.completed` é reconexão que o próprio Codex recuperou
  const motivos = [...falhas, ...(concluiu ? [] : avisos)];
  return { texto: mensagens.filter(Boolean).join("\n"), usage, falha: motivos.join("; ").slice(0, 500) || null };
}

function argumentos(dir, schemaPath, modelo) {
  const args = [
    "exec", "--cd", dir, "--sandbox", "read-only", "--skip-git-repo-check",
    "--ephemeral", "--ignore-user-config", "--ignore-rules", "--json",
    "--output-schema", schemaPath, "--model", modelo,
  ];
  if (process.platform === "win32") {
    args.push("-c", `windows.sandbox="${process.env.CODEX_SANDBOX_WINDOWS || SANDBOX_WINDOWS_PADRAO}"`);
  }
  args.push(PROMPT_TEXTO);
  return args;
}

/**
 * Como invocar o Codex sem shell. No Windows o `codex` do npm é um .cmd, e
 * passar por `cmd.exe` quebra o prompt nos espaços; rodar o codex.js do pacote
 * com o próprio Node evita o shell (e as regras de aspas dele) por completo.
 */
function comandoCodex() {
  if (process.env.CODEX_BIN) return { cmd: process.env.CODEX_BIN, pre: [] };
  if (process.platform !== "win32") return { cmd: "codex", pre: [] };
  const onde = execFileSync("where.exe", ["codex.cmd"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
  const js = join(dirname(onde), "node_modules", "@openai", "codex", "bin", "codex.js");
  if (!existsSync(js)) throw new Error(`Codex CLI não encontrado em ${js}. Instale com npm i -g @openai/codex.`);
  return { cmd: process.execPath, pre: [js] };
}

function rodarCodex(args, entrada, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { cmd, pre } = comandoCodex();
    const proc = spawn(cmd, [...pre, ...args], { windowsHide: true });
    let saida = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`Codex CLI excedeu ${timeoutMs / 1000}s`)); }, timeoutMs);
    proc.stdout.on("data", (d) => { saida += d; });
    proc.stderr.on("data", (d) => { saida += d; });
    proc.on("error", (e) => { clearTimeout(timer); reject(new Error(`Codex CLI não executou: ${e.message}`)); });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Codex CLI falhou (exit ${code}): ${saida.slice(-400)}`));
      resolve(saida);
    });
    proc.stdin.end(entrada, "utf8");
  });
}

async function viaCodex(request) {
  const schema = request.output_config?.format?.schema;
  if (!schema) throw new Error("request sem output_config.format.schema");

  const vazio = mkdtempSync(join(tmpdir(), "order-ops-codex-"));
  const fora = mkdtempSync(join(tmpdir(), "order-ops-schema-"));
  const schemaPath = join(fora, "schema.json");
  writeFileSync(schemaPath, JSON.stringify(schema));
  const entrada = achatar(request);
  const timeoutMs = Number(process.env.TIMEOUT_LLM_MS || 180_000);

  const tentar = async (modelo) => {
    const saida = await rodarCodex(argumentos(vazio, schemaPath, modelo), entrada, timeoutMs);
    const { texto, usage, falha } = lerStream(saida);
    if (falha) throw new Error(`Codex CLI abortou com exit 0: ${falha}`);
    if (!texto) throw new Error("Codex CLI não devolveu mensagem");
    return {
      type: "message",
      model: `codex/${modelo}`,
      stop_reason: "end_turn",
      content: [{ type: "text", text: texto }],
      usage: usage ? { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 } : null,
    };
  };

  try {
    const principal = codexModelo();
    try {
      return await tentar(principal);
    } catch (e) {
      const reserva = codexReserva();
      const motivo = String(e.message).toLowerCase();
      if (!reserva || !RECUSAS_DO_MODELO.some((m) => motivo.includes(m))) throw e;
      console.warn(`>>> ${principal} recusado (${String(e.message).slice(0, 160)}); seguindo com ${reserva}.`);
      return await tentar(reserva);
    }
  } finally {
    rmSync(vazio, { recursive: true, force: true });
    rmSync(fora, { recursive: true, force: true });
  }
}
