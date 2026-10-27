import crypto from "node:crypto";
import { authGet, authRun, authTx } from "@/db/auth-store";
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
  return redeemQuoteRef(digest(token), b);
}

/**
 * Référence d'un devis = l'empreinte de son jeton. C'est elle, jamais le jeton, que
 * porte le requestState de l'élicitation : le codec du SDK signe sans chiffrer, et
 * un jeton lisible par le client lui permettrait de confirmer par confirmation_token
 * sans répondre au dialogue (même après l'avoir refusé).
 */
export const quoteRef = digest;

/** Comme redeemQuote, à partir de la référence (empreinte) du devis. */
export async function redeemQuoteRef(ref: string, b: QuoteBinding): Promise<RedeemOutcome> {
  const now = nowStr();
  const row = await authTx((tx) => tx.get<{ cost_centi: number }>(
    `UPDATE mcp_quotes SET used_at = ? WHERE token_hash = ? AND user_id = ? AND grant_id = ? AND tool = ? AND args_hash = ?
       AND used_at IS NULL AND expires_at > ? RETURNING cost_centi`,
    now, ref, b.userId, b.grantId, b.tool, argsHash(b.args), now,
  ));
  if (!row) return "invalid";
  return Number(row.cost_centi) === b.costCenti ? "ok" : "cost_changed";
}

/**
 * Une demande de confirmation pour EXACTEMENT cette action (compte, autorisation, outil,
 * arguments) attend-elle sans réponse depuis plus de `olderThanS` secondes ? Sert au
 * repli : un client qui a reçu le dialogue sans l'afficher rappelle l'outil, et reçoit
 * cette fois le devis à jeton au lieu d'un nouveau dialogue.
 */
export async function hasUnansweredQuote(b: QuoteBinding, olderThanS: number): Promise<boolean> {
  const now = nowStr();
  const row = await authGet<{ n: number }>(
    `SELECT count(*) n FROM mcp_quotes WHERE user_id = ? AND grant_id = ? AND tool = ? AND args_hash = ?
       AND used_at IS NULL AND expires_at > ? AND created_at < ?`,
    b.userId, b.grantId, b.tool, argsHash(b.args), now, nowStr(-olderThanS * 1000),
  );
  return Number(row?.n ?? 0) > 0;
}

/**
 * Brûle TOUS les devis encore ouverts pour exactement cette action : un refus dans le
 * dialogue est définitif. Sans cela, une demande plus ancienne restée sans réponse
 * déclenchait, au rappel suivant, le repli sur un devis à jeton malgré le refus.
 */
export async function burnOpenQuotes(b: QuoteBinding): Promise<void> {
  const now = nowStr();
  await authRun(
    `UPDATE mcp_quotes SET used_at = ? WHERE user_id = ? AND grant_id = ? AND tool = ? AND args_hash = ? AND used_at IS NULL`,
    now, b.userId, b.grantId, b.tool, argsHash(b.args),
  );
}
