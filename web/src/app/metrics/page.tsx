import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Header, Stat } from "../components";
import { TARGETS, formatDuration, parseBrandMetrics, pct, share } from "@/lib/metrics";

const PERIODS = [
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
  { key: "all", label: "All time", days: null },
] as const;

/** Verde dentro da meta, vermelho fora; sem dado, neutro. */
const tone = (ok: boolean | null): string => (ok === null ? "" : ok ? "text-ok" : "text-bad");

export default async function MetricsPage(props: PageProps<"/metrics">) {
  const sp = await props.searchParams;
  const period = PERIODS.find((p) => p.key === sp.period) ?? PERIODS[1];

  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  // SECURITY INVOKER: o RLS limita às marcas do usuário
  const { data, error } = await supabase.rpc("brand_metrics", { p_days: period.days });
  const rows = parseBrandMetrics(data);

  const reviewed = rows.reduce((s, r) => s + r.ordersReviewed, 0);
  const auto = rows.reduce((s, r) => s + r.autoApproved, 0);
  const human = rows.reduce((s, r) => s + r.needsHuman, 0);
  const pending = rows.reduce((s, r) => s + r.syncPending, 0);
  const humanShare = share(human, reviewed);

  return (
    <>
      <Header email={claims?.claims?.email as string | undefined} />
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Metrics</h1>
            <p className="text-sm text-muted">
              Targets: AI review p95 under {TARGETS.reviewP95Seconds} s, and under {pct(TARGETS.humanShare)} of orders needing a person.
            </p>
          </div>
          <nav className="flex gap-1 rounded-lg border border-border bg-surface p-1 text-sm">
            {PERIODS.map((p) => (
              <Link key={p.key} href={`/metrics?period=${p.key}`}
                className={`rounded-md px-3 py-1.5 ${p.key === period.key ? "bg-accent text-white dark:text-black" : "text-muted hover:text-foreground"}`}>
                {p.label}
              </Link>
            ))}
          </nav>
        </div>

        {error && <p className="text-sm text-bad">Could not load metrics: {error.message}</p>}

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Orders reviewed" value={reviewed} />
          <Stat label="Auto-approved" value={pct(share(auto, reviewed))} hint={`${auto} of ${reviewed}`} />
          <Stat label="Needed a person" value={pct(humanShare)} hint={`target under ${pct(TARGETS.humanShare)}`} />
          <Stat label="Shopify sync pending" value={pending} hint="retried every 5 minutes" />
        </section>

        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2">Brand</th>
                <th className="px-4 py-2 text-right">Reviewed</th>
                <th className="px-4 py-2 text-right">Auto-approved</th>
                <th className="px-4 py-2 text-right">Needed a person</th>
                <th className="px-4 py-2 text-right">AI unavailable</th>
                <th className="px-4 py-2 text-right">AI review p50 / p95</th>
                <th className="px-4 py-2 text-right">Human decision p50 / p95</th>
                <th className="px-4 py-2 text-right">Sync pending</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const humanShareRow = share(r.needsHuman, r.ordersReviewed);
                return (
                  <tr key={r.brandId} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 font-medium">
                      <Link href={`/?brand=${r.brandId}`} className="hover:underline">{r.brandName}</Link>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.ordersReviewed}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{pct(share(r.autoApproved, r.ordersReviewed))}</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${tone(humanShareRow === null ? null : humanShareRow < TARGETS.humanShare)}`}>
                      {pct(humanShareRow)}
                    </td>
                    <td className={`px-4 py-2 text-right tabular-nums ${r.aiUnavailable > 0 ? "text-bad" : ""}`}>{r.aiUnavailable}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatDuration(r.reviewP50)} /{" "}
                      <span className={tone(r.reviewP95 === null ? null : r.reviewP95 < TARGETS.reviewP95Seconds)}>{formatDuration(r.reviewP95)}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatDuration(r.decisionP50)} / {formatDuration(r.decisionP95)}</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${r.syncPending > 0 ? "text-warn" : ""}`}>{r.syncPending}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && !error && (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-muted">No brands to show.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted">
          AI review: from the order being received to its first AI review. Human decision: from the latest AI review to the reviewer&apos;s decision.
          Percentiles are per brand; orders are counted by the date they were received.
        </p>
      </main>
    </>
  );
}
