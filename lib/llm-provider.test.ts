import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { achatar, lerStream, provedor, codexModelo, codexReserva } from "./llm-provider.ts";

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; });

const jsonl = (...eventos: object[]): string => eventos.map((e) => JSON.stringify(e)).join("\n");

test("stream concluído devolve a mensagem do agente e o uso", () => {
  const r = lerStream(jsonl(
    { type: "thread.started" },
    { type: "item.completed", item: { type: "reasoning", text: "..." } },
    { type: "item.completed", item: { type: "agent_message", text: '{"verdict":"ok"}' } },
    { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } },
  ));
  assert.equal(r.texto, '{"verdict":"ok"}');
  assert.equal(r.falha, null);
  assert.deepEqual(r.usage, { input_tokens: 100, output_tokens: 20 });
});

test("turn.failed é falha mesmo com exit 0", () => {
  const r = lerStream(jsonl({ type: "turn.failed", error: { message: "usage limit reached" } }));
  assert.match(r.falha ?? "", /usage limit/);
});

test("error seguido de turn.completed é reconexão recuperada, não falha", () => {
  const r = lerStream(jsonl(
    { type: "error", message: "Reconnecting... 2/5" },
    { type: "item.completed", item: { type: "agent_message", text: "{}" } },
    { type: "turn.completed" },
  ));
  assert.equal(r.falha, null);
});

test("error sem turno concluído é falha; linhas não-JSON são ignoradas", () => {
  const r = lerStream("aviso para humano\n" + jsonl({ type: "error", message: "stream disconnected" }));
  assert.match(r.falha ?? "", /stream disconnected/);
  assert.equal(r.texto, "");
});

test("achatar marca os papéis, com o system antes da tarefa", () => {
  const texto = achatar({ system: "regras", messages: [{ role: "user", content: "pedido" }] });
  assert.equal(texto, "[SYSTEM]\nregras\n\n[USER]\npedido");
});

test("provedor e modelos vêm do ambiente, com padrões", () => {
  delete process.env.LLM_PROVEDOR; delete process.env.CODEX_RUN_MODEL; delete process.env.CODEX_FALLBACK_MODEL;
  assert.equal(provedor(), "codex");
  assert.equal(codexModelo(), "gpt-5.6-luna");
  assert.equal(codexReserva(), "gpt-5.6-terra");
  process.env.CODEX_FALLBACK_MODEL = "nenhum";
  assert.equal(codexReserva(), null);
  process.env.LLM_PROVEDOR = "outro";
  assert.throws(() => provedor(), /inválido/);
});
