import crypto from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY, acceptedContent, createRequestStateCodec, inputRequired, inputResponse,
  type RequestStateCodec, type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { billingEnabled, creditsGate, fmtCredits, fromCenti, getBalanceCenti } from "@/lib/billing/credits";
import { dailyLimit, generationGate, usedToday } from "@/lib/billing/guards";
import { isOwner } from "@/lib/billing/owner";
import { llmUnavailableReason } from "@/lib/llm";
import { log } from "@/lib/metrics";
import type { Principal } from "@/lib/oauth/server";
import { QUOTE_TTL_S, argsHash, issueQuote, redeemQuote } from "./quotes";
import { QUOTA_LABEL, ToolError, codeForStatus, type Confirmation, type Cost, type Era } from "./tool";

/**
 * CONFIRMATION D'UN COÛT, avant toute dépense. Ordre fixe :
 *
 *  1. pré-vérification lecture seule avec les gardes de l'app (rafale + quota
 *     du jour, solde, moteur) : on ne fait pas confirmer ce qui sera refusé ;
 *  2. jeton de devis présenté → consommé s'il correspond exactement ;
 *  3. client 2026-07-28 qui déclare l'élicitation → `input_required` : la
 *     personne confirme dans son client, qui relance l'appel ; un `requestState`
 *     signé lie la réponse au compte, à l'outil, aux arguments et au coût ;
 *  4. sinon → devis à jeton unique (second appel).
 *
 * La dépense elle-même reste décidée par la réservation atomique de l'app
 * (lib/billing/reserve) : une confirmation n'est jamais un passe-droit.
 */

/**
 * Contenu signé du requestState. `n` = jeton d'un devis en base, émis avec la
 * question : la confirmation est consommée comme un devis, une seule fois — sans
 * lui, la même réponse rejouée pendant 10 min aurait débité à chaque fois.
 */
type StatePayload = { u: string; g: string; t: string; h: string; c: number; n: string };

/**
 * Clé HMAC du requestState : dérivée d'AUTH_SECRET (déjà posée en prod, partagée
 * si un jour plusieurs instances servent), sinon aléatoire par processus (dev).
 */
function stateKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (secret) return new Uint8Array(crypto.createHmac("sha256", secret).update("cortex-mcp-request-state-v1").digest());
  return new Uint8Array(crypto.randomBytes(32));
}

let _codec: RequestStateCodec<StatePayload> | null = null;
export function requestStateCodec(): RequestStateCodec<StatePayload> {
  if (!_codec) _codec = createRequestStateCodec<StatePayload>({ key: stateKey(), ttlSeconds: QUOTE_TTL_S });
  return _codec;
}

/** Marque d'un requestState refusé (expiré, signature fausse, malformé). */
const STALE = { stale: true } as const;
type Stale = typeof STALE;

/**
 * Vérification du requestState, branchée sur le SDK. Un état expiré ou invalide n'est
 * PAS une erreur de protocole : le SDK la rendrait opaque (« Invalid or expired
 * requestState ») et l'appel serait perdu — c'est ce qui arrive quand la personne met
 * plus de 10 min à répondre. L'appel continue sans état valide, donc SANS confirmation :
 * l'outil redemande l'accord en disant pourquoi. Rien ne part sans un état signé, lié
 * au compte, à l'outil, aux arguments et au coût, et consommé une seule fois.
 */
export async function verifyRequestState(
  state: string, ctx: Parameters<RequestStateCodec<StatePayload>["verify"]>[1],
): Promise<StatePayload | Stale> {
  try {
    return await requestStateCodec().verify(state, ctx);
  } catch (e) {
    log("info", "mcp.request_state_rejected", { reason: e instanceof Error ? e.message.slice(0, 40) : "unknown" });
    return STALE;
  }
}

const confirmSchema = z.object({ confirm: z.boolean().meta({ title: "Confirmer" }) });

function bucketLabel(bucket: Cost["bucket"]): "generations" | "assistance" {
  return bucket === "gen" ? "generations" : "assistance";
}

/** Pré-vérification avec les gardes de l'app (aucune écriture) : refus → ToolError. */
async function precheck(cost: Cost): Promise<void> {
  const gate = await generationGate(cost.bucket);
  if (gate) throw new ToolError(codeForStatus(gate.status), gate.error);
  const credits = await creditsGate(undefined, cost.costCenti);
  if (credits) throw new ToolError(codeForStatus(credits.status), credits.error);
  const engine = llmUnavailableReason();
  if (engine) throw new ToolError("unavailable", engine);
}

function costPhrase(costCenti: number, billing: boolean, owner: boolean): string {
  if (!billing) return "sans crédit (facturation désactivée sur cette instance)";
  if (owner) return "sans crédit (compte propriétaire)";
  return `${fmtCredits(costCenti)} crédit${costCenti > 100 ? "s" : ""}`;
}

export async function confirmCost(
  p: { principal: Principal; era: Era; mcpReq: ServerContext["mcpReq"]; tool: string },
  cost: Cost,
  args: Record<string, unknown>,
  token: string | undefined,
): Promise<Confirmation> {
  await precheck(cost);
  const billing = billingEnabled();
  // Compte du propriétaire : rien n'est débité ni compté (lib/billing/owner) — le devis le dit.
  const owner = await isOwner(p.principal.userId);
  const costCenti = billing && !owner ? cost.costCenti : 0;
  const binding = { userId: p.principal.userId, grantId: p.principal.grantId, tool: p.tool, args, costCenti };

  if (token) {
    const outcome = await redeemQuote(token, binding);
    if (outcome === "ok") return { kind: "confirmed" };
    throw new ToolError("confirmation_invalid", outcome === "cost_changed"
      ? "Le tarif a changé depuis le devis : rien n'a été débité. Redemande un devis (appel sans confirmation_token)."
      : "Jeton de confirmation invalide, expiré, déjà utilisé ou donné pour d'autres arguments : rien n'a été débité. Redemande un devis (appel sans confirmation_token).");
  }

  const used = await usedToday(cost.bucket);
  const limit = await dailyLimit(cost.bucket);
  const balance = billing ? await getBalanceCenti() : null;
  const quotaText = limit === null ? "quota du jour non limité" : `${QUOTA_LABEL[bucketLabel(cost.bucket)]} aujourd'hui : ${used}/${limit}`;
  const message = `${cost.summary} Coût : ${costPhrase(costCenti, billing, owner)}` +
    (balance !== null ? ` (solde ${fmtCredits(balance)} → ${fmtCredits(balance - costCenti)})` : "") + `, ${quotaText}. Confirmer ?`;

  // Capacités déclarées PAR REQUÊTE (ère 2026-07-28). Le type d'enveloppe du SDK est vide : lecture explicite.
  const envelope = p.mcpReq.envelope as Record<string, unknown> | undefined;
  const clientCaps = envelope?.[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: unknown } | undefined;
  if (p.era === "modern" && clientCaps?.elicitation) {
    const declined = (action: "decline" | "cancel"): Confirmation => ({
      kind: "declined",
      declined: { action, cost_credits: billing ? fromCenti(costCenti) : null, summary: cost.summary },
    });
    const answer = inputResponse(p.mcpReq.inputResponses, "confirm");
    if (answer.kind === "elicit" && answer.action !== "accept") return declined(answer.action === "cancel" ? "cancel" : "decline");
    const accepted = acceptedContent(p.mcpReq.inputResponses, "confirm", confirmSchema);
    const raw = p.mcpReq.requestState<StatePayload | Stale>();
    const stale = !!raw && "stale" in raw;
    const state = raw && !("stale" in raw) ? raw : undefined;
    const h = argsHash(args);
    const bound = state && state.u === binding.userId && state.g === binding.grantId && state.t === p.tool && state.h === h && state.c === costCenti;
    if (accepted?.confirm === true && bound) {
      if ((await redeemQuote(state.n, binding)) === "ok") return { kind: "confirmed" };
      throw new ToolError("confirmation_invalid", "Cette confirmation a déjà servi ou a expiré : rien n'a été débité. Relance la demande pour une nouvelle confirmation.");
    }
    if (accepted && accepted.confirm !== true) return declined("decline");
    return {
      kind: "input_required",
      result: inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: stale ? `La confirmation précédente a expiré ou n'est plus valable : rien n'a été lancé ni débité. ${message}` : message,
            requestedSchema: confirmSchema,
          }),
        },
        requestState: await requestStateCodec().mint({ u: binding.userId, g: binding.grantId, t: p.tool, h, c: costCenti, n: await issueQuote(binding) }),
      }),
    };
  }

  const quoteToken = await issueQuote(binding);
  return {
    kind: "quote",
    quote: {
      cost_credits: billing ? fromCenti(costCenti) : null,
      balance_credits: balance === null ? null : fromCenti(balance),
      balance_after_credits: balance === null ? null : fromCenti(balance - costCenti),
      daily_quota: { kind: bucketLabel(cost.bucket), used, limit },
      summary: message,
      confirmation_token: quoteToken,
      expires_in_seconds: QUOTE_TTL_S,
      how_to_confirm: "Show this cost to the user and ask for explicit approval. Only if they approve, call the same tool again with the same arguments plus confirmation_token. Never confirm on their behalf.",
    },
  };
}
