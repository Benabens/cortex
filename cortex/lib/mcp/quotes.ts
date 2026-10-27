import crypto from "node:crypto";
import { authRun, authTx } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { digest, newSecret } from "@/lib/oauth/secrets";

/**
 * DEVIS À USAGE UNIQUE — la confirmation « en deux temps » des clients qui ne
 * gèrent pas l'élicitation (ère 2025, serveur sans état). Le jeton est lié au
 * compte, à l'autorisation OAuth (l'application connectée), à l'outil, aux
 * arguments EXACTS et au coût annoncé ; il expire en 10 minutes et ne sert
 * qu'une fois. Seule son empreinte est stockée.
 */

export const QUOTE_TTL_S = 600;

export type QuoteBinding = { userId: string; grantId: string; tool: string; args: Record<string, unknown>; costCenti: number };

/** Empreinte canonique des arguments (clés triées, sans le jeton de confirmation). */
export function argsHash(args: Record<string, unknown>): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as object).sort().filter((k) => k !== "confirmation_token")
        .map((k) => [k, canon((v as Record<string, unknown>)[k])]).filter(([, x]) => x !== undefined));
    }
    return v;
  };
  return crypto.createHash("sha256").update(JSON.stringify(canon(args))).digest("hex");
}

export async function issueQuote(b: QuoteBinding): Promise<string> {
  const token = newSecret("quote");
  await authRun(`DELETE FROM mcp_quotes WHERE expires_at < ?`, nowStr(-86400_000));
  await authRun(
    `INSERT INTO mcp_quotes (token_hash, user_id, grant_id, tool, args_hash, cost_centi, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)`,
    digest(token), b.userId, b.grantId, b.tool, argsHash(b.args), b.costCenti, nowStr(), nowStr(QUOTE_TTL_S * 1000),
  );
  return token;
}

export type RedeemOutcome = "ok" | "invalid" | "cost_changed";

/**
 * Consomme le jeton s'il correspond EXACTEMENT (compte, autorisation, outil,
 * arguments) et n'est ni expiré ni déjà utilisé. Le coût est comparé au tarif
 * courant : s'il a changé depuis le devis, le jeton est brûlé et il faut
 * redemander un devis (la personne a confirmé un autre prix).
 */
export async function redeemQuote(token: string, b: QuoteBinding): Promise<RedeemOutcome> {
  const now = nowStr();
  const row = await authTx((tx) => tx.get<{ cost_centi: number }>(
    `UPDATE mcp_quotes SET used_at = ? WHERE token_hash = ? AND user_id = ? AND grant_id = ? AND tool = ? AND args_hash = ?
       AND used_at IS NULL AND expires_at > ? RETURNING cost_centi`,
    now, digest(token), b.userId, b.grantId, b.tool, argsHash(b.args), now,
  ));
  if (!row) return "invalid";
  return Number(row.cost_centi) === b.costCenti ? "ok" : "cost_changed";
}
