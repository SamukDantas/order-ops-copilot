export type OrderStatus =
  | "pending" | "reviewing" | "auto_approved" | "needs_review" | "approved" | "rejected" | "error";

export type Verdict = "ok" | "fix" | "reject" | "unavailable";

export interface Field { name: string; value: string }

export interface FieldCheck {
  name: string;
  value: string;
  length: number;
  max_chars: number | null;
  violations: string[];
}

export interface Review {
  id: string;
  verdict: Verdict;
  issues: string[];
  suggested_text: Field[] | null;
  customer_message: string | null;
  confidence: number;
  model: string;
  prompt_version: string;
  created_at: string;
  review_decisions: { action: "approve" | "edit" | "reject"; final_text: Field[] | null; note: string | null; created_at: string }[];
}

export interface OrderItem {
  id: string;
  title: string;
  sku: string | null;
  quantity: number;
  personalisation: Record<string, string>;
  checks: { passed: boolean; fields: FieldCheck[] };
  reviews: Review[];
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "Pending",
  reviewing: "AI reviewing",
  auto_approved: "Auto-approved",
  needs_review: "Needs review",
  approved: "Approved",
  rejected: "On hold",
  error: "Error",
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  ok: "Looks good",
  fix: "Correction suggested",
  reject: "Do not produce",
  unavailable: "AI unavailable",
};

export function latestReview(item: OrderItem): Review | undefined {
  return [...(item.reviews ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}
