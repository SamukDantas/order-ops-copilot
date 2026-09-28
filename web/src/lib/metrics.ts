/** Métricas por marca devolvidas pela função brand_metrics (RLS: só marcas do usuário). */
export interface BrandMetrics {
  brandId: string;
  brandName: string;
  ordersReviewed: number;
  autoApproved: number;
  needsHuman: number;
  aiUnavailable: number;
  reviewP50: number | null;
  reviewP95: number | null;
  decisionP50: number | null;
  decisionP95: number | null;
  syncPending: number;
}

/** Metas do TDD (§3). */
export const TARGETS = { reviewP95Seconds: 60, humanShare: 0.2 } as const;

const num = (x: unknown): number | null => {
  if (x === null || x === undefined) return null;
  const n = typeof x === "number" ? x : Number(x); // numeric do Postgres pode vir como string
  return Number.isFinite(n) ? n : null;
};

/** Valida a resposta da RPC; linhas malformadas são descartadas. */
export function parseBrandMetrics(data: unknown): BrandMetrics[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((r: unknown) => {
    if (typeof r !== "object" || r === null) return [];
    const o = r as Record<string, unknown>;
    if (typeof o.brand_id !== "string" || typeof o.brand_name !== "string") return [];
    return [{
      brandId: o.brand_id,
      brandName: o.brand_name,
      ordersReviewed: num(o.orders_reviewed) ?? 0,
      autoApproved: num(o.auto_approved) ?? 0,
      needsHuman: num(o.needs_human) ?? 0,
      aiUnavailable: num(o.ai_unavailable) ?? 0,
      reviewP50: num(o.review_p50_s),
      reviewP95: num(o.review_p95_s),
      decisionP50: num(o.decision_p50_s),
      decisionP95: num(o.decision_p95_s),
      syncPending: num(o.sync_pending) ?? 0,
    }];
  });
}

/** 12.3 s · 4.5 min · 2.1 h · 1.4 d */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "–";
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} d`;
}

export const share = (part: number, total: number): number | null => (total > 0 ? part / total : null);
export const pct = (x: number | null): string => (x === null ? "–" : `${Math.round(x * 100)}%`);
