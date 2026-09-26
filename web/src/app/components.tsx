import Link from "next/link";
import { signOut } from "./login/actions";
import { STATUS_LABEL, VERDICT_LABEL, type OrderStatus, type Verdict } from "@/lib/types";

export function Header({ email }: { email?: string }) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="font-semibold">Order Ops Copilot</Link>
        <div className="flex items-center gap-3 text-sm text-muted">
          <span className="hidden sm:inline">{email}</span>
          <form action={signOut}>
            <button className="rounded-md border border-border px-2 py-1 hover:text-foreground">Sign out</button>
          </form>
        </div>
      </div>
    </header>
  );
}

const STATUS_TONE: Record<OrderStatus, string> = {
  pending: "text-muted border-border",
  reviewing: "text-muted border-border",
  auto_approved: "text-ok border-ok/40",
  approved: "text-ok border-ok/40",
  needs_review: "text-warn border-warn/40",
  rejected: "text-bad border-bad/40",
  error: "text-bad border-bad/40",
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

const VERDICT_TONE: Record<Verdict, string> = {
  ok: "text-ok border-ok/40",
  fix: "text-warn border-warn/40",
  reject: "text-bad border-bad/40",
  unavailable: "text-bad border-bad/40",
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${VERDICT_TONE[verdict]}`}>
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}
