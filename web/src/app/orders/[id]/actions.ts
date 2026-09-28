"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requestShopifyWriteBack } from "@/lib/n8n";
import type { Field } from "@/lib/types";

const ACTIONS = new Set(["approve", "edit", "reject"]);

export async function decide(formData: FormData) {
  const orderId = String(formData.get("order_id") ?? "");
  const reviewId = String(formData.get("review_id") ?? "");
  const action = String(formData.get("action") ?? "");
  const note = String(formData.get("note") ?? "").trim() || null;
  const back = (msg: string) => redirect(`/orders/${orderId}?msg=${encodeURIComponent(msg)}`);

  if (!ACTIONS.has(action) || !reviewId) back("Invalid decision.");

  let finalText: Field[] | null = null;
  if (action === "edit") {
    finalText = [...formData.entries()]
      .filter(([k]) => k.startsWith("field:"))
      .map(([k, v]) => ({ name: k.slice("field:".length), value: String(v) }));
    if (finalText.length === 0) back("Nothing to save.");
  }

  // A autorização é feita no banco: decide_review checa papel de reviewer via RLS/is_brand_member
  const supabase = await createClient();
  const { data: status, error } = await supabase.rpc("decide_review", {
    p_review_id: reviewId,
    p_action: action,
    p_final_text: finalText,
    p_note: note,
  });
  if (error) back(`Could not save: ${error.message}`);

  if (status === "approved" || status === "rejected") {
    const wb = await requestShopifyWriteBack(orderId);
    if (wb.status === "sent") back("Decision saved and sent to Shopify.");
    if (wb.status === "disabled") back("Decision saved. Shopify write-back is disabled in this online demo (it runs in the full local setup).");
    // Na demo online o n8n roda na máquina do autor, atrás de um túnel: fora do ar, a decisão fica salva
    back(`Decision saved, but Shopify was not updated: the pipeline (n8n) did not respond (${wb.status === "failed" ? wb.error : "unknown"}). In the online demo it runs on the author's machine and may be offline.`);
  }
  back("Decision saved.");
}
