import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Header, Stat, StatusBadge } from "./components";
import type { OrderStatus } from "@/lib/types";

const TABS: { key: string; label: string; statuses: OrderStatus[] }[] = [
  { key: "review", label: "Needs review", statuses: ["needs_review", "error"] },
  { key: "auto", label: "Auto-approved", statuses: ["auto_approved"] },
  { key: "decided", label: "Decided", statuses: ["approved", "rejected"] },
  { key: "in-progress", label: "In progress", statuses: ["pending", "reviewing"] },
];

export default async function QueuePage(props: PageProps<"/">) {
  const sp = await props.searchParams;
  const tab = TABS.find((t) => t.key === sp.tab) ?? TABS[0];
  const brandFilter = typeof sp.brand === "string" ? sp.brand : undefined;

  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();

  // RLS: só marcas das quais o usuário é membro
  const { data: brands } = await supabase.from("brands").select("id, name").order("name");

  let statsQuery = supabase.from("orders").select("status");
  if (brandFilter) statsQuery = statsQuery.eq("brand_id", brandFilter);
  const { data: allStatuses } = await statsQuery;

  let listQuery = supabase
    .from("orders")
    .select("id, order_number, customer_first_name, status, created_at, brands(name), order_items(id, reviews(verdict, issues, created_at))")
    .in("status", tab.statuses)
    .order("created_at", { ascending: tab.key !== "review" ? false : true })
    .limit(100);
  if (brandFilter) listQuery = listQuery.eq("brand_id", brandFilter);
  const { data: orders, error } = await listQuery;

  const count = (s: OrderStatus[]) => (allStatuses ?? []).filter((o) => s.includes(o.status as OrderStatus)).length;
  const reviewed = count(["auto_approved", "needs_review", "approved", "rejected"]);
  const auto = count(["auto_approved"]);

  const href = (t: string, b = brandFilter) => `/?tab=${t}${b ? `&brand=${b}` : ""}`;

  return (
    <>
      <Header email={claims?.claims?.email as string | undefined} />
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6">
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Needs review" value={count(["needs_review", "error"])} />
          <Stat label="Auto-approved" value={reviewed ? `${Math.round((auto / reviewed) * 100)}%` : "–"} hint={`${auto} of ${reviewed} reviewed orders`} />
          <Stat label="Approved by team" value={count(["approved"])} />
          <Stat label="On hold" value={count(["rejected"])} />
        </section>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav className="flex gap-1 rounded-lg border border-border bg-surface p-1 text-sm">
            {TABS.map((t) => (
              <Link key={t.key} href={href(t.key)}
                className={`rounded-md px-3 py-1.5 ${t.key === tab.key ? "bg-accent text-white dark:text-black" : "text-muted hover:text-foreground"}`}>
                {t.label}
              </Link>
            ))}
          </nav>
          <nav className="flex flex-wrap gap-2 text-sm">
            <Link href={href(tab.key, undefined)} className={!brandFilter ? "font-medium" : "text-muted hover:text-foreground"}>All brands</Link>
            {(brands ?? []).map((b) => (
              <Link key={b.id} href={href(tab.key, b.id)} className={brandFilter === b.id ? "font-medium" : "text-muted hover:text-foreground"}>
                {b.name}
              </Link>
            ))}
          </nav>
        </div>

        {error && <p className="text-sm text-bad">Could not load orders: {error.message}</p>}

        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2">Order</th>
                <th className="px-4 py-2">Brand</th>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Main issue</th>
                <th className="px-4 py-2 text-right">Received</th>
              </tr>
            </thead>
            <tbody>
              {(orders ?? []).map((o) => {
                const issues = o.order_items.flatMap((i) => [...(i.reviews ?? [])]
                  .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.issues ?? []);
                const brand = Array.isArray(o.brands) ? o.brands[0] : o.brands;
                return (
                  <tr key={o.id} className="border-b border-border last:border-0 hover:bg-background">
                    <td className="px-4 py-2 font-medium"><Link href={`/orders/${o.id}`} className="hover:underline">{o.order_number}</Link></td>
                    <td className="px-4 py-2">{brand?.name}</td>
                    <td className="px-4 py-2">{o.customer_first_name ?? "–"}</td>
                    <td className="px-4 py-2"><StatusBadge status={o.status as OrderStatus} /></td>
                    <td className="max-w-xs truncate px-4 py-2 text-muted">{issues[0] ?? "–"}{issues.length > 1 ? ` (+${issues.length - 1})` : ""}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-muted">
                      {new Date(o.created_at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}
                    </td>
                  </tr>
                );
              })}
              {orders?.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-muted">Nothing here.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
