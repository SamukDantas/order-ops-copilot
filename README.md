# Order Ops Copilot

🌐 **English** · [Português](README.pt-BR.md)

**AI review of personalised Shopify orders, with a human in the loop only where it matters.**

A multi-brand D2C retailer sells made-to-order personalised products (engraving, printing, embroidery). Every order carries free text typed by the customer, and a typo, an emoji on an engraving or an offensive line that reaches production is a total loss: the item cannot be resold. Order Ops Copilot reviews **every personalised order automatically within seconds**, auto-approves the clean ones, and sends only the flagged ones, each with a suggested correction and a draft message for the customer, to an operations dashboard.

> Built AI-natively with Claude Code, from a [Technical Design Document](docs/TDD.md) through build, tests and evaluation. The LLM layer is provider-agnostic: by default it runs on the **Codex CLI** (ChatGPT account login, no paid API key), and the Claude Messages API is a drop-in alternative.

## Live demo

**https://order-ops-copilot.vercel.app** · login `demo@order-ops-copilot.dev` · password `!UserTest30`

The demo account is a reviewer on both brands. The online demo runs the dashboard on Vercel and Supabase (London) with orders that the AI really reviewed: 2 auto-approved and 5 waiting for a person, including the prompt-injection attempt. The AI pipeline (n8n, the LLM gateway and the Codex CLI) runs in the local setup below, so in the demo your decisions are saved but the Shopify write-back is disabled. Demo data is reset from time to time.

| Review queue | Correction suggested by the AI |
|---|---|
| ![Review queue with KPIs, status tabs and brand filter](docs/screenshots/queue.png) | ![Order page with the customer's text, the suggested fix, checks and decision buttons](docs/screenshots/order-suggestion.png) |
| **Prompt injection caught by both layers** | **Reviewer scoped to a single brand (RLS), dark theme** |
| ![Order whose engraving tries to instruct the reviewer, flagged "Do not produce"](docs/screenshots/order-prompt-injection.png) | ![Queue as seen by a reviewer who only belongs to one brand](docs/screenshots/queue-dark-single-brand.png) |

---

## Highlights

- **About 10 s per item from webhook to decision:** Shopify `orders/create` → Supabase Edge Function (HMAC-verified, idempotent) → n8n workflow → LLM → Postgres → dashboard.
- **Hard rules in code, judgement in the model.** Character limits, supported character sets, emoji and prompt-injection patterns are deterministic checks the model cannot override. The model handles typos, impossible dates, profanity, trademarks and tone.
- **Fail-safe by construction.** Any AI failure (refusal, timeout, invalid JSON, low confidence) routes the item to a person with the verdict `unavailable`. Nothing is auto-approved on uncertainty.
- **Evaluated, versioned prompts.** 24 labelled cases, and a prompt ships only if flag recall stays at 100% and unsafe auto-approvals stay at 0. The evaluation caught a real prompt-injection hole in v1, fixed in v2 (see the [evaluation log](docs/EVALS.md)).
- **Row Level Security across brands.** Reviewers see and act only on their brands. Decisions go through a `SECURITY DEFINER` function that re-checks role and product rules server-side. Covered by integration tests that sign in as real users.
- **Workflows generated from code.** The n8n JSON is generated from the same modules the tests and the evaluation exercise, so the prompt that is evaluated is the prompt that runs.

## Architecture

```mermaid
flowchart TB
    STORE["Shopify store<br/>one per brand"]
    OPS(["Operations team"])

    subgraph SB["Supabase"]
        direction LR
        EF["Edge Function<br/>shopify-webhook"]
        DB[("Postgres<br/>RLS by brand")]
    end

    subgraph N8N["n8n (Docker)"]
        direction LR
        WF1["Review order<br/>webhook + 5-min sweep"]
        WF2["Apply decision<br/>tags + note"]
        WF3["Error handler"]
    end

    subgraph HOST["LLM layer (host)"]
        direction LR
        GW["LLM gateway"]
        CODEX["Codex CLI<br/>default"]
        CLAUDE["Claude API<br/>optional"]
    end

    UI["Next.js dashboard"]

    STORE -- "1 orders/create, HMAC signed" --> EF
    EF -- "2 verify, dedupe, checks, persist" --> DB
    EF -- "3 notify" --> WF1
    WF1 -- "4 claim + save results" --> DB
    WF1 -- "5 review request" --> GW
    GW --> CODEX
    GW -.-> CLAUDE
    WF1 -- "6a auto-approved" --> WF2
    OPS --> UI
    UI -- "6b read + decide, user JWT" --> DB
    UI -- "7 decision taken" --> WF2
    WF2 -- "8 tags + note" --> STORE
    WF1 -. "failures" .-> WF3
    WF2 -. "failures" .-> WF3
    WF3 -- "workflow_errors" --> DB
```

| Component | Responsibility | Why it lives there |
|---|---|---|
| **Edge Function** | Verify HMAC over the raw body, deduplicate by `X-Shopify-Webhook-Id`, run deterministic checks, persist | Shopify needs a response within 5 s and retries on failure. Persisting first means no order is lost if n8n or the LLM is down. |
| **n8n** | Orchestration: claim, LLM call, retries, routing, write-back, error handling | Operations can see every run, retry it and change branching without a deploy. |
| **LLM gateway** | One stable contract in front of any provider | n8n runs in a container, while the Codex CLI and its login live on the host. Switching provider is an environment variable, not a workflow change. |
| **Postgres + RLS** | Source of truth and access control | One policy layer protects the dashboard, the API and anything built later. Atomic functions make each workflow step all-or-nothing. |
| **Dashboard** | Human-in-the-loop review | Holds only the publishable key and acts with the signed-in user's JWT. It never sees `service_role`. |

### n8n workflows

Both workflows are generated from code (`npm run workflows`) and imported by CLI. Node names are in Portuguese, the author's working language.

**Review order:** two entry points (the Edge Function webhook and a 5-minute sweep for pending orders) share one path: an atomic claim, one LLM request per item with 3 retries, validation and routing, a transactional save, and then either the Shopify write-back or the failure log.

![n8n workflow "Revisar pedido": webhook and 5-minute schedule into claim, LLM review, routing, save, Shopify write-back and failure logging](docs/screenshots/n8n-review-order.png)

**Apply decision:** fetches the decided order, builds tags and a note (including any text a reviewer corrected), then calls the Shopify Admin API in live mode or a mock in development, and logs the result either way.

![n8n workflow "Aplicar decisão no Shopify": webhook, fetch order, build tags and note, live or mock Shopify call, log the sync](docs/screenshots/n8n-apply-decision.png)

A third workflow, **error handler**, is wired as the error workflow for both and writes every failure to `workflow_errors`.

## Order lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant S as Shopify
    participant EF as Edge Function
    participant DB as Postgres
    participant N as n8n
    participant GW as LLM gateway
    participant L as Codex CLI
    participant UI as Dashboard
    actor R as Reviewer

    S->>EF: POST orders/create (HMAC)
    EF->>EF: verify HMAC, skip if webhook id already seen
    EF->>DB: upsert order + items with deterministic checks
    EF-->>S: 200 accepted
    EF-)N: notify(order_id)

    N->>DB: claim_orders_for_review(order_id)
    Note over N,DB: FOR UPDATE SKIP LOCKED, status pending to reviewing
    DB-->>N: order, items, checks, product rules

    loop each personalised item
        N->>GW: review request (prompt vN + JSON schema)
        GW->>L: codex exec, prompt on stdin, --output-schema
        L-->>GW: JSONL events, final message
        GW-->>N: normalised message
        N->>N: validate JSON, route item
    end

    N->>DB: save_review_results (one transaction)

    alt checks passed, verdict ok, confidence at or above brand threshold
        N->>N: apply-decision webhook
        N->>S: tagsAdd personalisation-ok + note
        N->>DB: shopify_sync_log
    else anything flagged, uncertain or failed
        Note over DB,UI: order waits as needs_review
        R->>UI: open order
        UI->>DB: read order, reviews, checks (RLS)
        R->>UI: approve, approve with correction, or hold
        UI->>DB: decide_review (role and product rules re-checked)
        DB-->>UI: order approved or on hold
        UI->>N: apply-decision webhook
        N->>S: tags + note with the final text
        N->>DB: shopify_sync_log
    end

    opt n8n unreachable when the webhook arrived
        N->>DB: 5-minute sweep claims orders pending over 2 min or stuck reviewing over 10 min
    end
```

### Order status

```mermaid
stateDiagram-v2
    [*] --> pending: webhook stored
    pending --> reviewing: claimed by n8n
    reviewing --> auto_approved: all items clean and confident
    reviewing --> needs_review: any item flagged, uncertain or AI unavailable
    reviewing --> reviewing: stuck over 10 min, reclaimed by the sweep
    needs_review --> approved: every item decided, none held
    needs_review --> rejected: any item put on hold
    auto_approved --> [*]
    approved --> [*]
    rejected --> [*]
```

## AI design

| Layer | What it does |
|---|---|
| **Deterministic checks** (`supabase/functions/_shared/checks.ts`) | Per-product character limit (counted in code points), allowed charset per technique, emoji detection including variation selectors and ZWJ sequences, whitespace, and text addressed to the reviewer or system. A failed check can never be auto-approved. |
| **Prompt** (`prompts/personalisation-review.v2.md`) | Verdict `ok`, `fix` or `reject`, specific issues, a suggested correction for every field, confidence, and a draft customer message in British English. Personalisation is delimited as data and declared unable to change the task. |
| **Output contract** (`prompts/review-schema.json`) | Strict JSON schema, enforced by the provider (`--output-schema` on Codex, structured outputs on Claude) and validated again in the workflow. |
| **Routing** (`lib/review-logic.ts`) | Auto-approve only when checks passed, the verdict is `ok` and confidence meets the brand's threshold. One flagged item holds the whole order. |
| **Provider** (`lib/llm-provider.ts`) | `codex` (default): `codex exec` headless with a read-only sandbox in an empty temp dir, machine config and rules ignored, ephemeral, JSONL where `turn.failed` is a failure even on exit 0, and a fallback model on plan or limit refusals. Default model `gpt-5.6-luna` (short, high-volume task), fallback `gpt-5.6-terra`. `anthropic`: Claude Messages API via the official SDK. |

**Evaluation.** `npm run eval` runs the labelled set through the same request and provider as production and reports exact accuracy, flag precision and recall, and the routed metrics that matter operationally: **unsafe auto-approvals** (must be 0) and unneeded human reviews.

| Prompt | Cases | Exact | Flag recall | Unsafe auto-approvals |
|---|---|---|---|---|
| v1 | 22 | 95% | 92% | 1 (prompt injection) |
| v2 + injection check | 24 | 100% | 100% | 0 |

Details in [docs/EVALS.md](docs/EVALS.md).

## Security and reliability

- **Shopify HMAC** verified in constant time over the raw body. Invalid signatures get `401` and nothing is stored.
- **Idempotency** by webhook id. Redeliveries return `duplicate`, and upserts never reset an order's status.
- **Persist first, notify second.** The 5-minute sweep recovers orders if n8n was down, and reclaims runs that died mid-review.
- **Retries** (3, with backoff) on the LLM and on the database write. After that the item fails safe to a human, and the error is written to `workflow_errors` by a dedicated n8n error workflow.
- **Secrets** live only in `.env`, n8n credentials and Edge Function secrets. n8n webhooks and the LLM gateway require shared secrets, compared in constant time.
- **RLS on every table.** Workflow functions are executable by `service_role` only. `decide_review` re-checks the reviewer role, refuses to approve text that breaks product rules, and refuses edits over the character limit.

## Tech stack

**Language:** TypeScript end to end, in strict mode (`noUncheckedIndexedAccess`, `erasableSyntaxOnly`). Node 24 runs it natively through type stripping, with no build step. The n8n Code nodes get the same logic with its types removed at generation time.
**Data and backend:** Supabase (Postgres, Row Level Security, Auth, Edge Functions on Deno)
**Orchestration:** n8n 2.x (Docker), workflows generated from code
**AI:** Codex CLI (`gpt-5.6-luna`) or Claude Messages API, behind a small typed gateway (Node + TypeScript)
**Frontend:** Next.js 16 (App Router, Server Actions, `proxy.ts`), React 19, Tailwind CSS 4
**Testing:** `tsc` strict + `deno check`, Deno test, Node test runner, RLS integration tests against local Supabase, LLM evaluation set, Playwright for screenshots

## Running locally

Prerequisites: Docker, Node 22+, Deno, and the [Codex CLI](https://github.com/openai/codex) logged in once (`codex`).

```bash
npm install && npm install --prefix web
npx supabase start          # Postgres, Auth, Edge runtime; applies migrations + seed
npm run setup               # writes .env, web/.env.local, function env and n8n credentials
npm run functions:serve     # Shopify webhook endpoint (keep running)
npm run gateway             # LLM gateway on :8787 (keep running)
npm run n8n:up && npm run n8n:import
npm run seed:usuarios       # demo users (local only)
npm run web                 # dashboard on http://localhost:3000
npm run simular -- all      # send the sample Shopify orders
```

Demo users: `ops@demo.test` (admin, both brands), `reviewer@demo.test` (reviewer, Engrave & Co), `viewer@demo.test` (read-only, Little Stitch). The local-only password is in `scripts/demo-config.ts`.

| Command | Purpose |
|---|---|
| `npm test` | Typecheck (`tsc` + `deno check`) and unit tests (Node + Deno) |
| `npm run typecheck` | Typecheck only |
| `npm run test:integration` | RLS and decision rules against local Supabase |
| `npm run eval` | Prompt evaluation (one real LLM call per case) |
| `npm run workflows` | Regenerate `n8n/workflows/` from `lib/` and `prompts/` |
| `npm run simular -- <fixture> [--novo-id] [--duplicar] [--hmac-invalido]` | Signed webhook simulator |

To use Claude instead of Codex, set `LLM_PROVEDOR=anthropic` and `ANTHROPIC_API_KEY` in `.env` and restart the gateway.

## Project structure

```
docs/                 TDD, evaluation log, screenshots
supabase/
  migrations/         schema, RLS, workflow and decision functions
  functions/          shopify-webhook + shared checks and HMAC (Deno)
lib/                  review request, routing logic, LLM provider (single source for n8n and evals)
services/             LLM gateway
prompts/              versioned prompts + output schema
n8n/                  docker-compose + generated workflows
evals/                labelled cases
fixtures/shopify/     realistic orders/create payloads
scripts/              setup, workflow generator, simulator, eval, seeds, screenshots
tests/                RLS integration tests
web/                  Next.js dashboard
```

> Code comments and commit messages are in Brazilian Portuguese (the author's working language). The product and the UI are in English; this README is also available in [Portuguese](README.pt-BR.md).

## Known limitations and next steps

- **Real Shopify development store:** write-back runs in mock mode today (`SHOPIFY_MODE=mock`), and the live path (Admin GraphQL `tagsAdd` + `orderUpdate`) is wired but not yet exercised against a store.
- **Field order:** personalisation is stored as a `jsonb` object, and Postgres normalises key order. It should become an ordered list of `{name, value}`, which the rest of the pipeline already uses.
- **Product limits** come from a static SKU table (`product_rules`). A later version should read them from Shopify metafields.
- **Full pipeline online:** the dashboard and database are live (see [Live demo](#live-demo)). Running the AI pipeline online as well needs n8n and the LLM gateway on a small always-on host, plus a hosted provider instead of a personal Codex login.
- **Metrics:** p95 time-to-review and auto-approval rate per brand, from the data already stored.

## Author

**Samuel Dantas**, full stack software engineer · [GitHub](https://github.com/SamukDantas) · [LinkedIn](https://linkedin.com/in/samuel-dantas-3a10882b4)
