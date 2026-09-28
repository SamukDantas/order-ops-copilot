# Order Ops Copilot

Revisão automática, com IA, da personalização de pedidos do Shopify, com revisão humana só do que for sinalizado. Design completo em [docs/TDD.md](docs/TDD.md): leia antes de mudar arquitetura, schema ou fluxo.

## Mapa

- `supabase/migrations/`: schema, RLS e funções (`claim_orders_for_review`, `save_review_results`, `decide_review`)
- `supabase/functions/shopify-webhook/`: entrada dos webhooks (HMAC, idempotência, persistência)
- `supabase/functions/_shared/`: verificações determinísticas e HMAC (Deno, testado com `deno test`)
- `lib/`: requisição de revisão, lógica de roteamento e provedor de LLM. **Fonte única**: é injetada nos workflows do n8n
- `services/llm-gateway.ts`: porta entre o n8n (container) e o provedor no host. `LLM_PROVEDOR=codex` (padrão, Codex CLI com login ChatGPT, mesma metodologia do squad-engenharia) ou `anthropic`
- `prompts/`: prompts versionados + schema de saída
- `n8n/workflows/`: **gerado** por `npm run workflows`. Nunca edite o JSON à mão; edite `scripts/gerar-workflows.ts` ou `lib/`
- `evals/cases.json`: conjunto rotulado; `npm run eval` mede o prompt (uma chamada real por caso: cota do Codex ou crédito da API)
- `fixtures/shopify/` + `npm run simular`: webhooks assinados para testar sem loja real

## Regras

- Toda mudança de prompt gera uma **nova versão** (`personalisation-review.vN.md` + `PROMPT_VERSION`) e só entra se o eval não regredir (recall de sinalização = 100%).
- Regras duras (limite, charset) ficam no código determinístico; o modelo nunca as sobrescreve.
- Na dúvida, o sistema manda para humano: qualquer falha de IA vira `needs_review`, nunca `auto_approved`.
- Segredos só em `.env` / credenciais do n8n / secrets das Edge Functions. O browser nunca recebe `service_role`.
- Tabelas novas: RLS habilitado na mesma migration, com policy por `is_brand_member`.
- TypeScript estrito em todo o código (sem `.js`/`.mjs` novos, fora arquivos de config de ferramentas). Só sintaxe apagável (`erasableSyntaxOnly`): o Node roda os `.ts` direto, sem build. Dados vindos de rede/JSON entram como `unknown` e são validados antes de usar.
- Commits em pt-BR; fluxo branch → PR → merge.

## Comandos

```bash
npm test                 # typecheck (tsc + deno check) + unit (Node + Deno)
npm run typecheck        # só o typecheck
npm run workflows        # regenera n8n/workflows a partir de lib/ e prompts/
npm run db:reset         # recria o banco local com migrations + seed
npm run simular -- all   # envia todos os webhooks de exemplo
npm run gateway          # sobe o gateway de LLM (obrigatório para o n8n revisar)
npm run test:integration # RLS contra o Supabase local
npm run shopify -- verificar        # loja de desenvolvimento real (token por client credentials)
npm run shopify -- catalogo         # produtos + metafields order_ops.* (regras sincronizadas pelo workflow 04)
npm run n8n:alvo -- <local|nuvem>   # Supabase que o n8n usa
npm run tunel            # expõe só os webhooks do n8n (ngrok, domínio fixo)
```

Loja real: `order-ops-copilot-demo.myshopify.com` (marca "Order Ops Demo Store"). Webhook `orders/create` → Edge Function do projeto online; `SHOPIFY_MODE=live` só vale para `SHOPIFY_STORE_DOMAIN`.
