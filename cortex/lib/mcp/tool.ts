import type { InputRequiredResult } from "@modelcontextprotocol/server";
import type * as z from "zod/v4";
import type { CourseConfig } from "@/lib/courses";
import type { Principal } from "@/lib/oauth/server";

/**
 * CONTRAT D'UN OUTIL MCP — une capacité = un fichier de lib/mcp/tools/, déclaré
 * par `defineTool`. Le fichier ne connaît ni le transport, ni le jeton, ni le SDK :
 * il reçoit des arguments déjà validés et un `ToolCtx`, et rend une valeur que le
 * serveur valide contre `output` avant de l'envoyer (lib/mcp/server.ts).
 */

/** Ère du protocole d'une requête : 2025 (« initialize ») ou 2026-07-28 (enveloppe par requête). */
export type Era = "legacy" | "modern";

/**
 * Lecture (portée cortex.read, gratuite), génération (portée cortex.generate, coût
 * confirmé) ou administration des cours (portée cortex.admin, propriétaire seulement).
 */
export type ToolKind = "read" | "generate" | "admin";

/** Codes d'erreur d'outil, lisibles par le modèle dans `_meta["com.cortexexam/error"]`. */
export type ToolErrorCode =
  | "invalid_input"
  | "not_found"
  | "insufficient_credits"
  | "quota_exceeded"
  | "conflict"
  | "confirmation_invalid"
  | "unavailable"
  | "too_large"
  | "forbidden"
  | "internal";

/**
 * Erreur attendue d'un outil : son message va TEL QUEL au client (français,
 * sans contenu de cours, sans détail technique). Toute autre exception devient
 * « internal » avec un message générique.
 */
export class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Statut HTTP d'un refus de l'app (réservation, pré-checks) → code d'outil. */
export function codeForStatus(status: number): ToolErrorCode {
  if (status === 402) return "insufficient_credits";
  if (status === 429) return "quota_exceeded";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 413 || status === 415) return "invalid_input";
  if (status === 412 || status === 503 || status === 507) return "unavailable";
  return "internal";
}

/** Ce que coûte une action, tel que l'app le facture. */
export type Cost = {
  /** Compteur du quota du jour consommé : gros jobs ou assistance. */
  bucket: "gen" | "assist";
  /** Coût en centièmes de crédit (unité du ledger). */
  costCenti: number;
  /** Ce qui sera fait, en une phrase (affiché dans la confirmation). */
  summary: string;
};

/** Issue d'une demande de confirmation. */
export type Confirmation =
  | { kind: "confirmed" }
  | { kind: "declined"; declined: DeclinedView }
  | { kind: "quote"; quote: QuoteView }
  | { kind: "input_required"; result: InputRequiredResult };

/**
 * Confirmation par élicitation qui n'a pas abouti : refusée par la personne
 * (« decline ») ou fermée / impossible à afficher (« cancel », ex. session non
 * interactive). Jamais de jeton de repli : une confirmation ratée ne se
 * transforme pas en devis que le modèle pourrait confirmer seul.
 */
export type DeclinedView = { action: "decline" | "cancel"; cost_credits: number | null; summary: string };

/** Devis rendu au client qui ne gère pas l'élicitation (second appel avec le jeton). */
export type QuoteView = {
  cost_credits: number | null;
  balance_credits: number | null;
  balance_after_credits: number | null;
  daily_quota: { kind: "generations" | "assistance"; used: number; limit: number | null };
  summary: string;
  confirmation_token: string;
  expires_in_seconds: number;
  how_to_confirm: string;
};

export type ToolCtx = {
  /** Compte au nom duquel tout s'exécute (issu du jeton, jamais d'un argument). */
  principal: Principal;
  era: Era;
  /** URL publique de l'app (liens « ouvrir dans Cortex »). */
  appOrigin: string;
  signal: AbortSignal;
  /**
   * Résout le cours demandé (identifiant, code ou nom) parmi ceux DU COMPTE et
   * exécute `fn` dans son contexte (tenant, chemins). Cours absent ou d'un autre
   * compte : ToolError « not_found » — même message, aucune requête au tenant.
   */
  inCourse<T>(ref: string | undefined, fn: (course: CourseConfig) => Promise<T>): Promise<T>;
  /**
   * Fait confirmer un coût AVANT toute dépense : élicitation si le client la gère
   * (ère 2026-07-28), sinon devis à jeton unique. `args` = arguments qui
   * déterminent l'action (le jeton n'est valable que pour eux).
   */
  confirm(cost: Cost, args: Record<string, unknown>, token: string | undefined): Promise<Confirmation>;
  /** Signale au client que le travail avance (anti-timeout des appels longs). */
  progress(message: string): Promise<void>;
};

export type ToolDef<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> = {
  /** ^[a-z][a-z0-9_]*$ — anglais, lu par le modèle. */
  name: string;
  title: string;
  /** Écrite pour qu'un modèle choisisse le bon outil (anglais). */
  description: string;
  kind: ToolKind;
  /** Va chercher des données hors de Cortex (annotation openWorldHint) — ex. une URL fournie. */
  openWorld?: boolean;
  input: I;
  output: O;
  /**
   * Corps de l'outil. Aucun effet de bord avant une confirmation obtenue
   * (ctx.confirm) pour un outil de génération. Peut rendre un `input_required`
   * (élicitation) via ctx.confirm.
   */
  run(args: z.infer<I>, ctx: ToolCtx): Promise<z.infer<O> | InputRequiredResult>;
  /** Résumé lisible (français) placé avant le bloc de données. */
  summarize(out: z.infer<O>): string;
};

/** Libellé français d'un compteur du jour (devis, refus). */
export const QUOTA_LABEL: Record<QuoteView["daily_quota"]["kind"], string> = { generations: "générations", assistance: "assistances" };

/**
 * Issue d'une confirmation qui N'AUTORISE PAS encore la dépense : la question au
 * client (élicitation), le devis ou le refus, mis en forme pour la sortie de
 * l'outil. null = confirmée, l'outil continue.
 */
export function pendingResult<B extends object>(decision: Confirmation, base: B):
  | InputRequiredResult
  | (B & { status: "confirmation_required"; confirmation: QuoteView })
  | (B & { status: "declined"; declined: DeclinedView })
  | null {
  if (decision.kind === "input_required") return decision.result;
  if (decision.kind === "quote") return { ...base, status: "confirmation_required", confirmation: decision.quote };
  if (decision.kind === "declined") return { ...base, status: "declined", declined: decision.declined };
  return null;
}

export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}
