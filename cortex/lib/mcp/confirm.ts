import crypto from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, acceptedContent, createRequestStateCodec, inputRequired, inputResponse,
  type RequestStateCodec, type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { billingEnabled, creditsGate, fmtCredits, fromCenti, getBalanceCenti } from "@/lib/billing/credits";
import { dailyLimit, generationGate, usedToday } from "@/lib/billing/guards";
import { isOwner } from "@/lib/billing/owner";
import { llmUnavailableReason } from "@/lib/llm";
import { log } from "@/lib/metrics";
import type { Principal } from "@/lib/oauth/server";
import { QUOTE_TTL_S, argsHash, hasUnansweredQuote, issueQuote, quoteRef, redeemQuote, redeemQuoteRef } from "./quotes";
import { QUOTA_LABEL, ToolError, codeForStatus, type Confirmation, type Cost, type Era } from "./tool";

/**
 * CONFIRMATION D'UN COÛT, avant toute dépense. Ordre fixe :
 *
 *  1. pré-vérification lecture seule avec les gardes de l'app (rafale + quota
 *     du jour, solde, moteur) : on ne fait pas confirmer ce qui sera refusé ;
 *  2. coût nul (le propriétaire, ou facturation désactivée) → rien à confirmer ;
 *  3. jeton de devis présenté → consommé s'il correspond exactement ;
 *  4. client qui AFFICHE l'élicitation (MCP_ELICITATION_CLIENTS, défaut Claude
 *     Code) en ère 2026-07-28 → `input_required` : la personne confirme dans son
 *     client, qui relance l'appel ; un `requestState` signé lie la réponse au
 *     compte, à l'outil, aux arguments et au coût. Si une demande pour la même
 *     action est restée plus de 30 s sans réponse, repli sur le devis ;
 *  5. sinon — le cas par défaut : claude.ai, Claude Desktop et Cowork annoncent
 *     l'élicitation sans l'afficher, l'appel pendait jusqu'à expirer (27/10/2026)
 *     → devis à jeton unique : Claude demande l'accord dans la conversation, puis
 *     rappelle l'outil avec le jeton.
 *
 * La dépense elle-même reste décidée par la réservation atomique de l'app
 * (lib/billing/reserve) : une confirmation n'est jamais un passe-droit.
 */

/**
 * Contenu signé (et LISIBLE par le client) du requestState. `n` = RÉFÉRENCE d'un
 * devis en base (l'empreinte de son jeton, jamais le jeton), émis avec la question :
 * la confirmation est consommée comme un devis, une seule fois — sans lui, la même
 * réponse rejouée pendant 10 min aurait débité à chaque fois.
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

/**
 * Marque d'un requestState refusé (expiré, signature fausse, malformé). Une valeur et
 * non `undefined` : pour le SDK, un vérificateur qui ne rend rien laisse passer l'état
 * brut, et l'outil ne saurait pas dire à la personne pourquoi on lui redemande.
 */
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
export async function verifyRequestState(state: string, ctx: ServerContext): Promise<StatePayload | Stale> {
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

/**
 * Clients qui affichent vraiment l'élicitation : noms clientInfo séparés par des
 * virgules dans MCP_ELICITATION_CLIENTS (défaut « claude-code » ; vide = personne).
 */
function showsElicitation(clientName: unknown): boolean {
  if (typeof clientName !== "string" || !clientName.trim()) return false;
  const allowed = (process.env.MCP_ELICITATION_CLIENTS ?? "claude-code").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(clientName.trim().toLowerCase());
}

/** Au-delà, une demande restée sans réponse cède la place au devis à jeton. */
const ELICITATION_FALLBACK_S = 30;

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
  // Rien à payer : rien à confirmer, l'action part directement.
  if (costCenti === 0) return { kind: "confirmed" };
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
  const clientName = (envelope?.[CLIENT_INFO_META_KEY] as { name?: unknown } | undefined)?.name;
  const answer = inputResponse(p.mcpReq.inputResponses, "confirm");
  const elicit = p.era === "modern" && !!clientCaps?.elicitation && showsElicitation(clientName)
    && (answer.kind !== "missing" || !(await hasUnansweredQuote(binding, ELICITATION_FALLBACK_S)));
  if (elicit) {
    const declined = (action: "decline" | "cancel"): Confirmation => ({
      kind: "declined",
      declined: { action, cost_credits: billing ? fromCenti(costCenti) : null, summary: cost.summary },
    });
    const raw = p.mcpReq.requestState<StatePayload | Stale>();
    const stale = !!raw && "stale" in raw;
    const state = raw && !("stale" in raw) ? raw : undefined;
    const h = argsHash(args);
    const bound = state && state.u === binding.userId && state.g === binding.grantId && state.t === p.tool && state.h === h && state.c === costCenti;
    if (answer.kind === "elicit" && answer.action !== "accept") {
      // Un refus BRÛLE le devis de la question : il ne peut plus servir, par aucun chemin.
      if (bound) await redeemQuoteRef(state.n, binding);
      return declined(answer.action === "cancel" ? "cancel" : "decline");
    }
    const accepted = acceptedContent(p.mcpReq.inputResponses, "confirm", confirmSchema);
    if (accepted?.confirm === true && bound) {
      if ((await redeemQuoteRef(state.n, binding)) === "ok") return { kind: "confirmed" };
      throw new ToolError("confirmation_invalid", "Cette confirmation a déjà servi ou a expiré : rien n'a été débité. Relance la demande pour une nouvelle confirmation.");
    }
    if (accepted && accepted.confirm !== true) {
      if (bound) await redeemQuoteRef(state.n, binding);
      return declined("decline");
    }
    return {
      kind: "input_required",
      result: inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: stale ? `La confirmation précédente a expiré ou n'est plus valable : rien n'a été lancé ni débité. ${message}` : message,
            requestedSchema: confirmSchema,
          }),
        },
        requestState: await requestStateCodec().mint({ u: binding.userId, g: binding.grantId, t: p.tool, h, c: costCenti, n: quoteRef(await issueQuote(binding)) }),
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
