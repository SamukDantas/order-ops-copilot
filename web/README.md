# Dashboard

Review dashboard for Order Ops Copilot: the queue of personalised orders, the AI's findings for each item, and the approve / edit / hold decision. See the [project README](../README.md) for the whole system.

**Live:** https://order-ops-copilot.vercel.app (demo login in the project README)

## Stack

| Technology | Version |
|---|---|
| [Next.js](https://nextjs.org) (App Router, Server Actions, `proxy.ts`) | 16.3 |
| [React](https://react.dev) | 19.2 |
| [Tailwind CSS](https://tailwindcss.com) | 4.3 |
| [supabase-js](https://github.com/supabase/supabase-js) + [@supabase/ssr](https://github.com/supabase/ssr) | 2.117 + 0.12 |
| TypeScript | 5.9 |

## Pages

| Route | What it does |
|---|---|
| `/login` | Email and password sign-in with Supabase Auth |
| `/` | Review queue: KPIs, status tabs and brand filter, limited to the signed-in user's brands |
| `/orders/[id]` | Customer text, deterministic checks, AI verdict and suggested fix, draft customer message, decision form and the latest Shopify sync |
| `/metrics` | Per brand: auto-approval and human-review shares, p50/p95 time to AI review and to human decision, pending Shopify syncs; 7 days, 30 days or all time, against the TDD targets |

## How it stays safe

- **Only the publishable key.** Every query runs with the signed-in user's JWT, so Row Level Security decides what each person sees. The `service_role` key never reaches this app.
- **`proxy.ts`** refreshes the Supabase session on each request and sends signed-out users to `/login`. It is an optimistic check: the real authorization is RLS in the database.
- **Decisions go through `decide_review`** (a Postgres function), which checks the reviewer role again and refuses text that breaks the product rules.
- **Shopify write-back** runs in n8n, not here. After a decision the Server Action calls the n8n `apply-decision` webhook with a shared secret (`src/lib/n8n.ts`) and reports one of three outcomes: sent, disabled (no n8n configured) or failed (for example, the pipeline is offline). The decision is saved in every case, and a failed write-back is retried by n8n every 5 minutes; the order page shows "Shopify update pending" until it succeeds.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | Publishable key (safe in the browser; RLS protects the data) |
| `N8N_BASE_URL` | no | n8n base URL for the write-back; without it the write-back is reported as disabled |
| `N8N_WEBHOOK_SECRET` | with `N8N_BASE_URL` | Shared secret for the n8n webhooks (server-side only; a sensitive variable on Vercel) |

Locally, `npm run setup` at the repo root writes `web/.env.local` pointing at the local Supabase and n8n.

## Commands

```bash
npm run dev     # http://localhost:3000
npm run build   # production build
npm run lint
npx tsc --noEmit
```

## Deploy

Vercel project `order-ops-copilot`, root directory `web/`, region `lhr1` (London, next to the Supabase project; see `vercel.json`). Pushes to `main` deploy to production. In the online demo, `N8N_BASE_URL` points at the fixed-domain ngrok tunnel that exposes only the n8n webhooks.

> This Next.js version has breaking changes compared with older releases: see `AGENTS.md` before changing framework code.
