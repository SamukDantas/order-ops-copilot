# Order Ops Copilot

Revisão automática, com IA, da personalização de pedidos do Shopify, com revisão humana só do que for sinalizado. Design completo em [docs/TDD.md](docs/TDD.md): leia antes de mudar arquitetura, schema ou fluxo.

## Mapa

- `supabase/migrations/`: schema, RLS e funções (`claim_orders_for_review`, `save_review_results`, `decide_review`)
- `supabase/functions/shopify-webhook/`: entrada dos webhooks (HMAC, idempotência, persistência)
- `supabase/functions/_shared/`: verificações determinísticas e HMAC (Deno, testado com `deno test`)
- `lib/`: requisição ao Claude e lógica de roteamento. **Fonte única**: é injetada nos workflows do n8n
- `prompts/`: prompts versionados + schema de saída
- `n8n/workflows/`: **gerado** por `npm run workflows`. Nunca edite o JSON à mão; edite `scripts/gerar-workflows.mjs` ou `lib/`
- `evals/cases.json`: conjunto rotulado; `npm run eval` mede o prompt (chama a API, custa dinheiro)
- `fixtures/shopify/` + `npm run simular`: webhooks assinados para testar sem loja real

## Regras

- Toda mudança de prompt gera uma **nova versão** (`personalisation-review.vN.md` + `PROMPT_VERSION`) e só entra se o eval não regredir (recall de sinalização = 100%).
- Regras duras (limite, charset) ficam no código determinístico; o modelo nunca as sobrescreve.
- Na dúvida, o sistema manda para humano: qualquer falha de IA vira `needs_review`, nunca `auto_approved`.
- Segredos só em `.env` / credenciais do n8n / secrets das Edge Functions. O browser nunca recebe `service_role`.
- Tabelas novas: RLS habilitado na mesma migration, com policy por `is_brand_member`.
- Commits em pt-BR; fluxo branch → PR → merge.

## Comandos

```bash
npm test                 # unit (Node + Deno)
npm run workflows        # regenera n8n/workflows a partir de lib/ e prompts/
npm run db:reset         # recria o banco local com migrations + seed
npm run simular -- all   # envia todos os webhooks de exemplo
```
