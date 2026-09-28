import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Header, StatusBadge, VerdictBadge } from "../../components";
import { decide } from "./actions";
import { latestReview, personalisationFields, type Field, type OrderItem, type OrderStatus } from "@/lib/types";

export default async function OrderPage(props: PageProps<"/orders/[id]">) {
  const { id } = await props.params;
  const { msg } = await props.searchParams;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();

  const { data: order } = await supabase
    .from("orders")
    .select(`id, order_number, customer_first_name, currency, total_price, status, status_changed_at, created_at, brand_id,
      brands(name),
      order_items(id, title, sku, quantity, personalisation, checks,
        reviews(id, verdict, issues, suggested_text, customer_message, confidence, model, prompt_version, created_at,
          review_decisions(action, final_text, note, created_at))),
      shopify_sync_log(mode, tags, note, ok, created_at)`)
    .eq("id", id)
    .maybeSingle();
  if (!order) notFound();

  const { data: membership } = await supabase
    .from("brand_members").select("role").eq("brand_id", order.brand_id).maybeSingle();
  const canDecide = order.status === "needs_review" && (membership?.role === "reviewer" || membership?.role === "admin");
  const brand = Array.isArray(order.brands) ? order.brands[0] : order.brands;
  const sync = [...(order.shopify_sync_log ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  // Decidido, mas sem write-back bem-sucedido depois da decisão: a varredura do n8n reenvia
  const decided = ["auto_approved", "approved", "rejected"].includes(order.status);
  const syncPending = decided && !(sync?.ok && sync.created_at >= order.status_changed_at);

  return (
    <>
      <Header email={claims?.claims?.email as string | undefined} />
      <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 px-4 py-6">
        <Link href="/" className="text-sm text-muted hover:text-foreground">← Back to queue</Link>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{order.order_number} · {brand?.name}</h1>
            <p className="text-sm text-muted">
              {order.customer_first_name ?? "Customer"} · {order.currency} {Number(order.total_price).toFixed(2)} ·{" "}
              {new Date(order.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
            </p>
          </div>
          <StatusBadge status={order.status as OrderStatus} />
        </div>

        {msg && <p className="rounded-md border border-border bg-surface px-3 py-2 text-sm">{msg}</p>}
        {sync && (
          <p className="text-xs text-muted">
            Shopify {sync.mode === "mock" ? "(mock)" : ""}: tags {sync.tags.join(", ")} {sync.ok ? "applied" : "failed"}.
          </p>
        )}
        {syncPending && (
          <p className="text-xs text-muted">
            Shopify update pending: retried automatically every 5 minutes while the pipeline is online.
          </p>
        )}

        {(order.order_items as OrderItem[]).map((item) => (
          <ItemCard key={item.id} item={item} orderId={order.id} canDecide={canDecide} />
        ))}
      </main>
    </>
  );
}

function ItemCard({ item, orderId, canDecide }: { item: OrderItem; orderId: string; canDecide: boolean }) {
  const review = latestReview(item);
  const decision = review?.review_decisions?.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const original: Field[] = personalisationFields(item.personalisation);
  const suggestion = review?.suggested_text ?? null;
  const prefill = suggestion ?? original;

  return (
    <section className="space-y-4 rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{item.title} <span className="text-sm text-muted">{item.sku} × {item.quantity}</span></h2>
        {review && <VerdictBadge verdict={review.verdict} />}
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted">
          <tr><th className="py-1">Field</th><th>Customer typed</th>{suggestion && <th>Suggested</th>}<th className="text-right">Checks</th></tr>
        </thead>
        <tbody>
          {original.map((f) => {
            const check = item.checks?.fields?.find((c) => c.name === f.name);
            const sug = suggestion?.find((s) => s.name === f.name)?.value;
            return (
              <tr key={f.name} className="border-t border-border align-top">
                <td className="py-2 pr-3 text-muted">{f.name}</td>
                <td className="py-2 pr-3 font-mono whitespace-pre-wrap">{f.value}</td>
                {suggestion && <td className={`py-2 pr-3 font-mono whitespace-pre-wrap ${sug !== f.value ? "text-warn" : "text-muted"}`}>{sug ?? "–"}</td>}
                <td className="py-2 text-right text-xs tabular-nums">
                  {check && (
                    <span className={check.violations.length ? "text-bad" : "text-muted"}>
                      {check.length}{check.max_chars ? `/${check.max_chars}` : ""}
                      {check.violations.length > 0 && ` · ${check.violations.join(", ")}`}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {review && (
        <div className="space-y-2 text-sm">
          {review.issues.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5">{review.issues.map((i) => <li key={i}>{i}</li>)}</ul>
          )}
          {review.customer_message && (
            <details className="rounded-md border border-border p-3">
              <summary className="cursor-pointer text-muted">Draft message to customer</summary>
              <p className="mt-2 whitespace-pre-wrap">{review.customer_message}</p>
            </details>
          )}
          <p className="text-xs text-muted">
            Confidence {Math.round(review.confidence * 100)}% · {review.model} · {review.prompt_version}
          </p>
        </div>
      )}

      {decision && (
        <p className="rounded-md bg-background px-3 py-2 text-sm">
          Decision: <strong>{decision.action}</strong>
          {decision.final_text && <> · {decision.final_text.map((f) => `${f.name}: "${f.value}"`).join(", ")}</>}
          {decision.note && <> · {decision.note}</>}
        </p>
      )}

      {canDecide && review && !decision && (
        <div className="grid gap-3 border-t border-border pt-4 md:grid-cols-2">
          <form action={decide} className="space-y-2">
            <input type="hidden" name="order_id" value={orderId} />
            <input type="hidden" name="review_id" value={review.id} />
            <input name="note" placeholder="Note (optional)" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
            <div className="flex flex-wrap gap-2">
              {item.checks?.passed !== false ? (
                <button name="action" value="approve" className="rounded-md border border-ok/50 px-3 py-1.5 text-sm text-ok">Approve as typed</button>
              ) : (
                <p className="w-full text-xs text-muted">The text breaks this product&apos;s rules, so it can only be approved after an edit.</p>
              )}
              <button name="action" value="reject" className="rounded-md border border-bad/50 px-3 py-1.5 text-sm text-bad">Put on hold</button>
            </div>
          </form>
          <form action={decide} className="space-y-2">
            <input type="hidden" name="order_id" value={orderId} />
            <input type="hidden" name="review_id" value={review.id} />
            <input type="hidden" name="action" value="edit" />
            {prefill.map((f) => (
              <label key={f.name} className="block text-xs text-muted">
                {f.name}
                <input name={`field:${f.name}`} defaultValue={f.value}
                  className="mt-0.5 w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm text-foreground" />
              </label>
            ))}
            <button className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white dark:text-black">
              {suggestion ? "Approve with correction" : "Approve with edit"}
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
