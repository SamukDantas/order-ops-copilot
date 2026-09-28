# Order Ops Copilot

🌐 [English](README.md) · **Português**

**Revisão com IA de pedidos personalizados do Shopify, com um humano no circuito só onde importa.**

Um varejista D2C multimarca vende produtos personalizados feitos sob encomenda (gravação, impressão, bordado). Cada pedido traz um texto livre digitado pelo cliente, e um erro de digitação, um emoji numa gravação ou uma frase ofensiva que chega à produção é prejuízo total: a peça não pode ser revendida. O Order Ops Copilot revisa **automaticamente, em segundos, todo pedido personalizado**, aprova sozinho os que estão corretos e envia só os sinalizados, cada um com uma correção sugerida e um rascunho de mensagem para o cliente, para um painel de operações.

> Construído de forma AI-native com Claude Code, de um [documento de design técnico](docs/TDD.md) até a implementação, os testes e a avaliação. A camada de LLM não depende de provedor: por padrão roda no **Codex CLI** (login da conta ChatGPT, sem chave de API paga), e a Messages API do Claude é uma alternativa direta.

## Demo online

**https://order-ops-copilot.vercel.app** · login `demo@order-ops-copilot.dev` · senha `!UserTest30`

A conta demo é revisora nas três marcas. A demo online roda o painel na Vercel e no Supabase (Londres) com pedidos que a IA revisou de verdade: nas duas marcas fictícias, 2 aprovados automaticamente e 5 aguardando uma pessoa, incluindo a tentativa de injeção de prompt. Os dados da demo são resetados de tempos em tempos.

A terceira marca, **Order Ops Demo Store**, é uma [loja de desenvolvimento real do Shopify](#loja-de-desenvolvimento-real-do-shopify): os pedidos chegam pelo webhook `orders/create` de verdade, e a decisão tomada na demo grava tags e nota no pedido pela Admin API. O pipeline de IA (n8n, gateway de LLM e Codex CLI) roda na máquina do autor, atrás de um túnel, então o ciclo com a loja real funciona enquanto ela está ligada; fora disso, a decisão é salva e chega ao Shopify automaticamente quando ela volta.

| Fila de revisão | Correção sugerida pela IA |
|---|---|
| ![Fila de revisão com indicadores, abas de status e filtro por marca](docs/screenshots/queue.png) | ![Página do pedido com o texto do cliente, a correção sugerida, as verificações e os botões de decisão](docs/screenshots/order-suggestion.png) |
| **Injeção de prompt barrada pelas duas camadas** | **Revisor restrito a uma marca (RLS), tema escuro** |
| ![Pedido cuja gravação tenta dar instruções ao revisor, marcado como "Do not produce"](docs/screenshots/order-prompt-injection.png) | ![Fila vista por um revisor que pertence a uma só marca](docs/screenshots/queue-dark-single-brand.png) |

> As telas estão em inglês porque o produto foi pensado para uma operação no Reino Unido.

---

## Destaques

- **Cerca de 10 s por item, do webhook à decisão:** Shopify `orders/create` → Supabase Edge Function (HMAC verificado, idempotente) → workflow n8n → LLM → Postgres → painel.
- **Regras duras no código, julgamento no modelo.** Limite de caracteres, conjunto de caracteres permitido, emoji e padrões de injeção de prompt são verificações determinísticas que o modelo não pode anular. Na loja real, o limite e a técnica de cada produto vêm dos metafields do Shopify, editáveis pelo lojista no admin. O modelo cuida de erros de digitação, datas impossíveis, palavrões, marcas registradas e tom.
- **Falha segura por construção.** Qualquer falha da IA (recusa, timeout, JSON inválido, baixa confiança) manda o item para uma pessoa com o veredito `unavailable`. Nada é aprovado automaticamente na dúvida.
- **Prompts versionados e avaliados.** 24 casos rotulados, e um prompt só entra se o recall de sinalização continuar em 100% e as aprovações automáticas indevidas em 0. A avaliação encontrou uma brecha real de injeção de prompt na v1, corrigida na v2 (veja o [histórico de avaliação](docs/EVALS.md)).
- **Row Level Security entre marcas.** Revisores só veem e decidem pedidos das próprias marcas. As decisões passam por uma função `SECURITY DEFINER` que confere de novo, no servidor, o papel do usuário e as regras do produto. Coberto por testes de integração que fazem login como usuários reais.
- **Workflows gerados a partir do código.** O JSON do n8n é gerado pelos mesmos módulos que os testes e a avaliação exercitam, então o prompt avaliado é o prompt que roda.
- **Métricas contra as metas do design.** Uma página de métricas mostra, por marca, a fatia aprovada automaticamente e a que precisou de revisão humana, e o p50/p95 do tempo até a revisão da IA e até a decisão humana, comparados às metas do TDD. O cálculo é feito no Postgres (`brand_metrics`) sob o RLS do usuário logado, então cada pessoa só vê as próprias marcas.

## Arquitetura

```mermaid
flowchart TB
    STORE["Loja Shopify<br/>uma por marca"]
    OPS(["Equipe de operações"])

    subgraph SB["Supabase"]
        direction LR
        EF["Edge Function<br/>shopify-webhook"]
        DB[("Postgres<br/>RLS por marca")]
    end

    subgraph N8N["n8n (Docker)"]
        direction LR
        WF1["Revisar pedido<br/>webhook + varredura a cada 5 min"]
        WF2["Aplicar decisão<br/>token + tags + nota<br/>+ reenvio a cada 5 min"]
        WF3["Tratar erros"]
        WF4["Sincronizar regras<br/>a cada hora, dos metafields"]
    end

    subgraph HOST["Camada de LLM (host)"]
        direction LR
        GW["Gateway de LLM"]
        CODEX["Codex CLI<br/>padrão"]
        CLAUDE["Claude API<br/>opcional"]
    end

    UI["Painel Next.js"]

    STORE -- "1 orders/create, assinado com HMAC" --> EF
    EF -- "2 verifica, deduplica, checa, persiste" --> DB
    EF -- "3 notifica" --> WF1
    WF1 -- "4 claim, grava resultados e falhas da IA" --> DB
    WF1 -- "5 pedido de revisão" --> GW
    GW --> CODEX
    GW -.-> CLAUDE
    WF1 -- "6a aprovado automaticamente" --> WF2
    OPS --> UI
    UI -- "6b lê + decide, JWT do usuário" --> DB
    UI -- "7 decisão tomada" --> WF2
    WF2 -- "8 lê o pedido, registra o sync" --> DB
    WF2 -- "9 token de acesso, depois tags + nota" --> STORE
    WF1 -. "execução quebrou" .-> WF3
    WF2 -. "execução quebrou" .-> WF3
    WF3 -- "workflow_errors" --> DB
    WF4 -. "lê os metafields dos produtos" .-> STORE
    WF4 -. "product_rules" .-> DB
```

| Componente | Responsabilidade | Por que fica ali |
|---|---|---|
| **Edge Function** | Verifica o HMAC sobre o corpo bruto, deduplica por `X-Shopify-Webhook-Id`, roda as verificações determinísticas e persiste | O Shopify exige resposta em até 5 s e reenvia em caso de falha. Persistir primeiro garante que nenhum pedido se perde se o n8n ou o LLM estiverem fora. |
| **n8n** | Orquestração: claim, chamada ao LLM, retentativas, roteamento, write-back, sincronização das regras e tratamento de erros | A operação vê cada execução, pode reexecutá-la e mudar ramificações sem deploy. |
| **Gateway de LLM** | Um contrato estável na frente de qualquer provedor | O n8n roda em container, enquanto o Codex CLI e o login dele ficam no host. Trocar de provedor é uma variável de ambiente, não uma mudança de workflow. |
| **Postgres + RLS** | Fonte da verdade e controle de acesso | Uma única camada de políticas protege o painel, a API e o que vier depois. Funções atômicas tornam cada passo do workflow tudo-ou-nada. |
| **Painel** | Revisão humana | Só tem a chave publicável e age com o JWT do usuário logado. Nunca vê a `service_role`. |

### Workflows do n8n

Os workflows são gerados a partir do código (`npm run workflows`) e importados por linha de comando.

**Revisar pedido:** duas entradas (o webhook da Edge Function e uma varredura de pendentes a cada 5 minutos) seguem pelo mesmo caminho: claim atômico, uma requisição ao LLM por item com 3 retentativas, validação e roteamento, gravação em uma transação e, no fim, o write-back no Shopify ou o registro da falha.

![Workflow n8n "Revisar pedido": webhook e agendamento de 5 minutos levando a claim, revisão pelo LLM, roteamento, gravação, write-back no Shopify e registro de falhas](docs/screenshots/n8n-review-order.png)

**Aplicar decisão no Shopify:** busca o pedido decidido e monta as tags e a nota (incluindo o texto corrigido pelo revisor, se houver). Em modo live, pede um token de acesso de curta duração (client credentials) e chama a Admin API do Shopify; em desenvolvimento, chama uma simulação. Nos dois casos, registra o resultado, inclusive as falhas. Uma segunda entrada, a varredura a cada 5 minutos, reaplica decisões sem sync bem-sucedido desde que foram tomadas (pipeline fora do ar ou falha no Shopify), até 5 tentativas com falha.

![Workflow n8n "Aplicar decisão no Shopify": webhook e varredura de reenvio a cada 5 minutos, busca do pedido, montagem de tags e nota, ramo live (token de acesso, depois tags e nota) ou simulado, registro do sync](docs/screenshots/n8n-apply-decision.png)

**Sincronizar regras do Shopify:** a cada hora (ou sob demanda, por um webhook interno), lê os metafields `order_ops.max_chars` e `order_ops.charset` dos produtos e variantes da loja e aplica em `product_rules` numa transação (`sync_product_rules`). A variante sobrescreve o produto; regra inválida é ignorada e registrada em `workflow_errors`, e o item cai nas verificações genéricas. A Edge Function continua lendo só o Postgres, então a ingestão nunca espera a Admin API.

Um quarto workflow, **Tratar erros**, é configurado como workflow de erro dos outros e grava cada falha em `workflow_errors`.

## Ciclo de vida do pedido

```mermaid
sequenceDiagram
    autonumber
    participant S as Shopify
    participant EF as Edge Function
    participant DB as Postgres
    participant N as n8n
    participant GW as Gateway de LLM
    participant L as Codex CLI
    participant UI as Painel
    actor R as Revisor

    opt a cada hora, independente dos pedidos (loja real)
        N->>S: token de acesso, depois produtos com metafields order_ops.*
        N->>DB: sync_product_rules (uma transação)
    end

    S->>EF: POST orders/create (HMAC)
    EF->>EF: verifica HMAC, ignora se o webhook id já foi visto
    Note over EF: loja desconhecida ou nenhum item personalizado: 200, nada a revisar
    EF->>DB: lê product_rules por SKU, upsert do pedido + itens com verificações determinísticas
    EF-)N: notify(order_id), em segundo plano
    EF-->>S: 200 accepted

    N->>DB: claim_orders_for_review(order_id)
    Note over N,DB: FOR UPDATE SKIP LOCKED, status de pending para reviewing
    DB-->>N: pedido, itens, verificações, charset, limiar da marca

    loop cada item personalizado
        N->>GW: pedido de revisão (prompt vN + schema JSON)
        GW->>L: codex exec, prompt pelo stdin, --output-schema
        L-->>GW: eventos JSONL, mensagem final
        GW-->>N: mensagem normalizada
        N->>N: valida o JSON, roteia o item
    end

    N->>DB: save_review_results (uma transação)
    opt IA indisponível para algum item
        N->>DB: workflow_errors
    end

    alt verificações ok, veredito ok, confiança no limiar da marca ou acima
        N->>N: webhook apply-decision
        N->>S: token de acesso (client credentials)
        N->>S: tagsAdd personalisation-ok + nota
        N->>DB: shopify_sync_log
    else algo sinalizado, incerto ou com falha
        Note over DB,UI: pedido aguarda como needs_review
        R->>UI: abre o pedido
        UI->>DB: lê pedido, revisões, verificações (RLS)
        R->>UI: aprova, aprova com correção ou retém
        UI->>DB: decide_review (papel e regras do produto conferidos de novo)
        DB-->>UI: pedido aprovado ou retido
        UI->>N: webhook apply-decision
        Note over UI,N: n8n fora do ar: a decisão continua salva e a varredura de 5 min a aplica quando o n8n volta
        N->>S: token de acesso, depois tags + nota com o texto final
        N->>DB: shopify_sync_log
    end
    Note over S,N: modo live só para SHOPIFY_STORE_DOMAIN, as outras marcas usam simulação

    opt n8n fora do ar quando o webhook chegou
        N->>DB: varredura a cada 5 min pega pedidos pendentes há mais de 2 min ou presos em revisão há mais de 10 min
    end

    opt decisão sem sync bem-sucedido (pipeline fora do ar, falha no Shopify)
        N->>DB: varredura a cada 5 min: orders_pending_sync e apply-decision de novo (até 5 falhas)
    end
```

### Status do pedido

```mermaid
stateDiagram-v2
    [*] --> pending: webhook gravado
    pending --> reviewing: claim pelo n8n
    reviewing --> auto_approved: todos os itens corretos e com confiança
    reviewing --> needs_review: algum item sinalizado, incerto ou IA indisponível
    reviewing --> reviewing: preso há mais de 10 min, retomado pela varredura
    needs_review --> approved: todos os itens decididos, nenhum retido
    needs_review --> rejected: algum item retido
    auto_approved --> [*]
    approved --> [*]
    rejected --> [*]
```

## Design da IA

| Camada | O que faz |
|---|---|
| **Verificações determinísticas** (`supabase/functions/_shared/checks.ts`) | Limite de caracteres por produto (contado em code points), charset permitido por técnica, detecção de emoji incluindo seletores de variação e sequências ZWJ, espaços e texto dirigido ao revisor ou ao sistema. Uma verificação reprovada nunca é aprovada automaticamente. |
| **Prompt** (`prompts/personalisation-review.v2.md`) | Veredito `ok`, `fix` ou `reject`, problemas específicos, correção sugerida para cada campo, confiança e rascunho de mensagem ao cliente em inglês britânico. A personalização é delimitada como dado e declarada incapaz de mudar a tarefa. |
| **Contrato de saída** (`prompts/review-schema.json`) | Schema JSON estrito, imposto pelo provedor (`--output-schema` no Codex, structured outputs no Claude) e validado de novo no workflow. |
| **Roteamento** (`lib/review-logic.ts`) | Só aprova automaticamente quando as verificações passaram, o veredito é `ok` e a confiança atinge o limiar da marca. Um item sinalizado segura o pedido inteiro. |
| **Provedor** (`lib/llm-provider.ts`) | `codex` (padrão): `codex exec` headless com sandbox read-only num diretório temporário vazio, config e rules da máquina ignoradas, execução efêmera, JSONL em que `turn.failed` é falha mesmo com exit 0, e modelo reserva quando há recusa por plano ou limite. Modelo padrão `gpt-5.6-luna` (tarefa curta e de volume), reserva `gpt-5.6-terra`. `anthropic`: Messages API do Claude pelo SDK oficial. |

**Avaliação.** O `npm run eval` passa o conjunto rotulado pela mesma requisição e pelo mesmo provedor da produção e mede o acerto exato, a precisão e o recall de sinalização, e as métricas de rota que importam na operação: **aprovações automáticas indevidas** (precisam ser 0) e revisões humanas desnecessárias.

| Prompt | Casos | Acerto exato | Recall de sinalização | Aprovações automáticas indevidas |
|---|---|---|---|---|
| v1 | 22 | 95% | 92% | 1 (injeção de prompt) |
| v2 + verificação de injeção | 24 | 100% | 100% | 0 |

Detalhes em [docs/EVALS.md](docs/EVALS.md) (em inglês).

## Segurança e confiabilidade

- **HMAC do Shopify** verificado em tempo constante sobre o corpo bruto. Assinatura inválida recebe `401` e nada é gravado.
- **Idempotência** pelo webhook id. Reentregas voltam como `duplicate`, e os upserts nunca reiniciam o status de um pedido.
- **Persistir primeiro, notificar depois.** A varredura a cada 5 minutos recupera pedidos se o n8n estava fora e retoma execuções que morreram no meio da revisão. Uma segunda varredura reaplica decisões cujo write-back no Shopify nunca deu certo e desiste depois de 5 tentativas com falha.
- **Retentativas** (3, com espera crescente) no LLM e na gravação no banco. Depois disso o item vai com segurança para uma pessoa, e o erro é gravado em `workflow_errors` por um workflow de erros dedicado.
- **Segredos** só no `.env`, nas credenciais do n8n, nos secrets das Edge Functions e nas variáveis sensíveis da Vercel. Os webhooks do n8n e o gateway de LLM exigem segredo compartilhado, comparado em tempo constante.
- **Acesso ao Shopify** por um token de 24 h do client credentials grant, pedido a cada write-back e nunca guardado. O app declara como dados protegidos só os dados do pedido e o nome do cliente.
- **Túnel** (demo online): uma traffic policy do ngrok só deixa passar `POST` nos dois webhooks do n8n; o editor e a API do n8n respondem 404.
- **RLS em todas as tabelas.** As funções do workflow só podem ser executadas pela `service_role`. A `decide_review` confere de novo o papel do revisor, recusa aprovar texto que viola as regras do produto e recusa edições acima do limite de caracteres.

## Stack

**Linguagem:** TypeScript de ponta a ponta, em modo estrito (`noUncheckedIndexedAccess`, `erasableSyntaxOnly`). O Node 24 executa os arquivos direto, por type stripping, sem etapa de build. Os Code nodes do n8n recebem a mesma lógica, com os tipos removidos na geração.

As versões são as usadas para construir e validar o projeto (setembro de 2026).

### Runtimes e infraestrutura

| Tecnologia | Versão | Papel |
|---|---|---|
| [Node.js](https://nodejs.org) | 24.21 (mínimo 22.18) | Scripts, gateway de LLM, testes; executa `.ts` direto |
| [TypeScript](https://www.typescriptlang.org) | 7.0 (raiz), 5.9 (painel) | Tipagem estrita em todo o código, só sintaxe apagável |
| [Deno](https://deno.com) | 2.9 | Runtime da Edge Function, `deno check` e `deno test` |
| [Docker](https://www.docker.com) + Compose | 29.6 + Compose 5.3 | Supabase local e n8n |
| CLI do [Supabase](https://supabase.com) | 2.118 | Stack local, migrations, deploy de funções, secrets |
| [PostgreSQL](https://www.postgresql.org) | 17.6 (Supabase) | Dados, Row Level Security, funções do workflow |
| [n8n](https://n8n.io) | 2.40.7 (imagem Docker fixada) | Orquestração; workflows gerados por código |
| Agente do [ngrok](https://ngrok.com) | 3.37 | Túnel com domínio fixo que expõe só os webhooks do n8n |
| [Vercel](https://vercel.com) | região `lhr1` | Hospedagem do painel, ao lado do Supabase em Londres |

### IA

| Tecnologia | Versão | Papel |
|---|---|---|
| [Codex CLI](https://github.com/openai/codex) | 0.155 | Provedor padrão, headless, com login da conta ChatGPT |
| Modelos via Codex | `gpt-5.6-luna` (principal), `gpt-5.6-terra` (reserva) | Revisão da personalização com schema JSON estrito |
| [SDK TypeScript da Anthropic](https://github.com/anthropics/anthropic-sdk-typescript) | 0.128 | Provedor alternativo (`LLM_PROVEDOR=anthropic`) |
| Modelo via Anthropic | `claude-opus-5` | Mesmo prompt e schema do caminho Codex |

### Shopify

| Tecnologia | Versão | Papel |
|---|---|---|
| Admin GraphQL API | `2026-07` | `orderCreate`, `tagsAdd`, `orderUpdate`, assinaturas de webhook; leitura de produtos e metafields, `productSet` e `metafieldDefinitionCreate` (catálogo) |
| Webhooks | `orders/create`, API `2026-07` | Entrada de pedidos, assinados com HMAC-SHA256 |
| App do Dev Dashboard | client credentials grant | Token de acesso de 24 h, sem OAuth interativo. Escopos: `read_orders`, `write_orders`, `read_products` e `write_products` (este só para o `catalogo`) |

### Painel

| Tecnologia | Versão | Papel |
|---|---|---|
| [Next.js](https://nextjs.org) | 16.3 | App Router, Server Actions, `proxy.ts` |
| [React](https://react.dev) | 19.2 | Interface |
| [Tailwind CSS](https://tailwindcss.com) | 4.3 | Estilos, temas claro e escuro |
| [supabase-js](https://github.com/supabase/supabase-js) + [@supabase/ssr](https://github.com/supabase/ssr) | 2.117 + 0.12 | Auth e consultas sob RLS (só a chave publicável) |
| [ESLint](https://eslint.org) | 9.39 | Lint (`eslint-config-next`) |

### Qualidade

| Tecnologia | Versão | Papel |
|---|---|---|
| Test runner do Node | embutido no Node 24 | Testes unitários (`lib/`) e de integração do RLS |
| Deno test | embutido no Deno 2.9 | Verificações determinísticas e HMAC |
| Conjunto de avaliação do LLM | 24 casos rotulados | Portão do prompt: não pode regredir (veja [EVALS](docs/EVALS.md)) |
| [Playwright](https://playwright.dev) | 1.63 | Capturas de tela do README |

### Contas e serviços

- **Shopify:** organização de parceiro com uma loja de desenvolvimento e um app no Dev Dashboard (gratuito).
- **Supabase:** um projeto para a demo online (o plano gratuito basta); a stack local não exige conta.
- **Vercel:** hospedagem do painel (plano Hobby).
- **ngrok:** conta gratuita; o domínio dev estático mantém a URL do túnel fixa.
- **LLM:** uma conta ChatGPT logada no Codex CLI ou uma chave da API da Anthropic com crédito.

## Rodando localmente

Pré-requisitos: Docker, Node 22.18+ (24 recomendado), Deno 2 e o [Codex CLI](https://github.com/openai/codex) com login feito uma vez (`codex`). O ambiente com a loja real também precisa do [agente do ngrok](https://ngrok.com/download).

```bash
npm install && npm install --prefix web
npx supabase start          # Postgres, Auth, Edge runtime; aplica migrations + seed
npm run setup               # gera .env, web/.env.local, env das functions e credenciais do n8n
npm run functions:serve     # endpoint do webhook do Shopify (deixe rodando)
npm run gateway             # gateway de LLM na porta 8787 (deixe rodando)
npm run n8n:up && npm run n8n:import
npm run seed:usuarios       # usuários de demonstração (só local)
npm run web                 # painel em http://localhost:3000
npm run simular -- all      # envia os pedidos de exemplo do Shopify
```

Usuários de demonstração: `ops@demo.test` (admin nas duas marcas), `reviewer@demo.test` (revisor na Engrave & Co) e `viewer@demo.test` (somente leitura na Little Stitch). A senha, válida só no ambiente local, está em `scripts/demo-config.ts`.

| Comando | Para quê |
|---|---|
| `npm test` | Typecheck (`tsc` + `deno check`) e testes unitários (Node + Deno) |
| `npm run typecheck` | Só o typecheck |
| `npm run test:integration` | RLS, regras de decisão e a sincronização das regras dos metafields contra o Supabase local |
| `npm run eval` | Avaliação do prompt (uma chamada real ao LLM por caso) |
| `npm run workflows` | Regenera `n8n/workflows/` a partir de `lib/` e `prompts/` |
| `npm run simular -- <fixture> [--novo-id] [--duplicar] [--hmac-invalido]` | Simulador de webhooks assinados |
| `npm run shopify -- verificar \| webhook <url> \| webhooks \| pedido <fixture\|all> \| catalogo` | Loja de desenvolvimento real: confere o acesso, registra `orders/create`, cria pedidos de teste, cria os produtos com as regras em metafields |
| `npm run n8n:alvo -- <local\|nuvem>` | Aponta o n8n para o Supabase local ou para o projeto da demo online |
| `npm run tunel` | Expõe só os dois webhooks do n8n pelo ngrok (domínio fixo) |

Para usar o Claude em vez do Codex, defina `LLM_PROVEDOR=anthropic` e `ANTHROPIC_API_KEY` no `.env` e reinicie o gateway.

## Loja de desenvolvimento real do Shopify

Além do simulador de webhooks assinados, o pipeline roda contra uma loja de desenvolvimento real (`order-ops-copilot-demo.myshopify.com`) e um app criado no Dev Dashboard do Shopify. Online, as peças ficam assim:

```mermaid
flowchart LR
    SHOP["Shopify<br/>loja de desenvolvimento"] -->|orders/create| EF["Edge Function<br/>Supabase, Londres"]
    EF --> DB[("Postgres<br/>Supabase, Londres")]
    UI["Painel<br/>Vercel lhr1"] --> DB
    EF -->|review-order| T{{"ngrok<br/>domínio fixo"}}
    UI -->|apply-decision| T
    subgraph HOST["Máquina do autor"]
        N8N["n8n"] --> GW["Gateway de LLM"] --> CODEX["Codex CLI"]
    end
    T --> N8N
    N8N --> DB
    N8N -->|tags + nota, lê metafields| SHOP
```


1. **Token de acesso:** o app e a loja são da mesma organização, então o token sai do *client credentials grant* (client ID + secret, sem OAuth interativo). Ele vale 24 h, por isso nada de longa duração fica guardado: o workflow de write-back pede um token novo a cada execução.
2. **Webhook:** `npm run shopify -- webhook <url>` assina `orders/create` na Edge Function do projeto online. O Shopify assina com o client secret do app, o único valor de que a função precisa.
3. **Dados protegidos de clientes:** o app declara só o mínimo (dados do pedido e o nome do cliente, do qual o revisor vê o primeiro nome). E-mail, telefone e endereço não são pedidos, então nem chegam ao sistema.
4. **Pedidos de teste:** `npm run shopify -- pedido <fixture|all>` cria pedidos de teste reais a partir das mesmas fixtures do simulador, com a personalização em line item properties. Quando o SKU existe na loja, o item aponta para a variante real do produto.
5. **Regras em metafields:** `npm run shopify -- catalogo` (exige o escopo `write_products`) cria as definições de metafield `order_ops.max_chars` e `order_ops.charset`, com validação, e os produtos das fixtures com seus limites. O lojista muda um limite na página do produto no admin do Shopify, e a sincronização horária leva a mudança para `product_rules`. Regras cadastradas à mão continuam valendo (`source = manual`), a menos que a loja defina o mesmo SKU.
6. **Ciclo completo:** `npm run n8n:alvo -- nuvem` aponta o n8n local para o projeto online, e `npm run tunel` expõe só `POST /webhook/review-order` e `POST /webhook/apply-decision` (uma traffic policy do ngrok responde 404 para o editor e a API do n8n; os webhooks continuam exigindo o segredo compartilhado). `SHOPIFY_MODE=live` vale só para `SHOPIFY_STORE_DOMAIN`; as marcas fictícias seguem em modo simulado.

Validado de ponta a ponta: o pedido #1001 ("Happy Anniversery") foi criado na loja, revisado pela IA (`fix`, 0,99, "Anniversary"), aprovado no painel online e recebeu no Shopify as tags `personalisation-ok` e `human-reviewed`, além da nota. As regras vindas dos metafields foram validadas do mesmo jeito: com o limite do chaveiro reduzido para 10 no admin do Shopify e sincronizado, o pedido #1003 ("Olivia & Tom", 12 caracteres, de resto limpo) foi sinalizado com `over_limit` e foi para um humano com uma sugestão mais curta.

## Estrutura do projeto

```
docs/                 TDD, histórico de avaliação, capturas de tela
supabase/
  migrations/         schema, RLS, funções do workflow e de decisão
  functions/          shopify-webhook + verificações e HMAC compartilhados (Deno)
lib/                  requisição de revisão, roteamento, provedor de LLM, cliente da Admin API e regras dos metafields do Shopify (fonte única para o n8n e o eval)
services/             gateway de LLM
prompts/              prompts versionados + schema de saída
n8n/                  docker-compose (n8n fixado), workflows gerados, política de tráfego do túnel
evals/                casos rotulados
fixtures/shopify/     payloads realistas de orders/create
scripts/              setup, gerador de workflows, simulador, loja real (shopify), alvo do n8n, túnel, eval, seeds, capturas
tests/                testes de integração (RLS, decisões e sincronização de regras)
web/                  painel Next.js
```

> Comentários de código e mensagens de commit estão em português do Brasil. O produto e a interface estão em inglês, e a documentação técnica (TDD e avaliação) também.

## Limitações conhecidas e próximos passos

- **Pipeline completo online:** o painel, o banco e o endpoint de webhooks já estão no ar, e o pipeline de IA os atende a partir da máquina do autor por um túnel (veja [Loja de desenvolvimento real do Shopify](#loja-de-desenvolvimento-real-do-shopify)). Deixá-lo sempre ligado exige o n8n e o gateway de LLM num host pequeno, com um provedor hospedado no lugar do login pessoal do Codex.
- **Histórico de métricas:** a página calcula a janela atual a cada acesso. Tendência ao longo do tempo (fotos diárias) e alertas quando uma marca sai da meta são o próximo passo.

## Autor

**Samuel Dantas**, engenheiro de software full stack · [GitHub](https://github.com/SamukDantas) · [LinkedIn](https://linkedin.com/in/samuel-dantas-3a10882b4)
