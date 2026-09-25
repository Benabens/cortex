import { billingEnabled, creditCost, getBalance, listTransactions } from "@/lib/billing/credits";
import { usedToday } from "@/lib/billing/guards";
import { useUser } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Solde de crédits + quotas du jour + packs disponibles (UI compte). */
export async function GET(req: NextRequest) {
  useUser(req);
  const packs = (["small", "medium", "large"] as const)
    .filter((p) => process.env[`STRIPE_PRICE_${p.toUpperCase()}`])
    .map((p) => ({
      pack: p,
      credits: Number(process.env[`CREDITS_PACK_${p.toUpperCase()}`] ?? { small: 1, medium: 5, large: 12 }[p]),
    }));
  return NextResponse.json({
    billing: billingEnabled(),
    balance: billingEnabled() ? await getBalance() : null,
    costs: { exam: creditCost("exam"), qcm: creditCost("qcm"), exercise: creditCost("exercise") },
    usedToday: { gen: await usedToday("gen"), assist: await usedToday("assist") },
    quotas: {
      gen: process.env.DAILY_GEN_QUOTA ? Number(process.env.DAILY_GEN_QUOTA) : null,
      assist: process.env.DAILY_ASSIST_QUOTA ? Number(process.env.DAILY_ASSIST_QUOTA) : null,
    },
    transactions: billingEnabled() ? await listTransactions() : [],
    packs,
  });
}
