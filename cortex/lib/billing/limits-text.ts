/**
 * LIMITES D'USAGE — types et phrases, sans dépendance serveur : partagés par
 * lib/billing/limits (serveur, MCP) et par l'interface (page compte, indicateur
 * à côté des boutons). Une seule façon de dire « il te reste… » et « remise à zéro… ».
 *
 * Les heures sont dites à l'heure de Lausanne : les compteurs du jour tournent à
 * minuit UTC, soit 01:00 en hiver et 02:00 en été — on annonce l'heure réelle.
 */

export type LimitKey =
  | "credits" | "daily_generations" | "daily_assistance" | "rate" | "active_jobs"
  | "free_capacity" | "free_budget" | "daily_compute" | "monthly_capacity" | "storage";

export type LaunchKind = "exam" | "qcm" | "exercise" | "prepare" | "check" | "drill";

/** Une limite qui peut bloquer l'étudiant. `unit` : crédits, générations, aides, %, Mo… (jamais de dollars). */
export type UsageLimit = {
  key: LimitKey;
  label: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  unit: string;
  /** Remise à zéro (ISO UTC), null = sans date (crédits achetés, jobs en cours, stockage). */
  resetAt: string | null;
};

/** Ce qu'il reste pour un type de génération, et le verdict d'un lancement maintenant. */
export type KindUsage = {
  kind: string;
  label: string;
  plural: string;
  /** Coût d'un lancement en crédits (0 : rien n'est débité, propriétaire ou facturation coupée). */
  costCredits: number;
  /** Lancements encore possibles d'après la limite la plus contraignante ; null = aucune limite. */
  remaining: number | null;
  limitedBy: LimitKey | null;
  resetAt: string | null;
  /** Un lancement maintenant passerait-il ? Sinon : la raison (même message que l'API) et sa remise à zéro. */
  allowed: boolean;
  reason: string | null;
  blockedBy: LimitKey | null;
  blockedUntil: string | null;
  status: number | null;
};

export type UsageLimits = {
  now: string;
  owner: boolean;
  billing: boolean;
  limits: UsageLimit[];
  generations: Record<LaunchKind, KindUsage>;
  /** Verdict pour une composition précise (taille d'examen choisie), quand on l'a demandé. */
  check: KindUsage | null;
};

const TZ = "Europe/Zurich";

function dayKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** « 01:00 » à l'heure de Lausanne. */
export function formatHour(iso: string): string {
  return new Intl.DateTimeFormat("fr-CH", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/**
 * Quand une limite se remet à zéro, dit comme à quelqu'un : « à 14:32 »,
 * « demain à 01:00 », « le 1er décembre ». `now` : « AAAA-MM-JJ HH:MM:SS » UTC ou ISO.
 */
export function formatReset(resetIso: string, now: string): string {
  const at = new Date(resetIso);
  const ref = new Date(now.includes("T") ? now : `${now.replace(" ", "T")}Z`);
  if (Number.isNaN(at.getTime())) return "bientôt";
  const today = dayKey(ref);
  const target = dayKey(at);
  const tomorrow = dayKey(new Date(ref.getTime() + 86_400_000));
  if (target === today) return `à ${formatHour(resetIso)}`;
  if (target === tomorrow) return `demain à ${formatHour(resetIso)}`;
  const day = Number(new Intl.DateTimeFormat("fr-CH", { timeZone: TZ, day: "numeric" }).format(at));
  const month = new Intl.DateTimeFormat("fr-CH", { timeZone: TZ, month: "long" }).format(at);
  return `le ${day === 1 ? "1er" : day} ${month}`;
}

const DAILY: ReadonlySet<LimitKey> = new Set(["daily_generations", "daily_assistance", "daily_compute"]);

/** « 3 examens QCM aujourd'hui », « 1 vérification avec ton solde » : un nombre, ce qu'il compte, sur quelle période. */
function countPhrase(n: number, u: KindUsage): string {
  const what = n >= 2 ? u.plural : u.label.replace(/ \(.*\)$/, "");
  const when = DAILY.has(u.limitedBy as LimitKey) ? " aujourd'hui"
    : u.limitedBy === "credits" ? " avec ton solde"
    : u.limitedBy === "monthly_capacity" ? " ce mois-ci" : "";
  return `${n} ${what}${when}`;
}

/** Remise à zéro de la limite qui borne (aucune pour un solde : il se recharge en achetant). */
function resetPhrase(u: KindUsage, now: string): string | null {
  return u.resetAt && u.limitedBy !== "credits" ? `remise à 0 ${formatReset(u.resetAt, now)}` : null;
}

/**
 * La ligne compacte affichée à côté d'un bouton de génération :
 * « Il te reste 3 examens QCM aujourd'hui · remise à 0 demain à 01:00 ».
 * null quand rien ne limite (propriétaire, instance sans limites).
 */
export function remainingLine(u: KindUsage, now: string): string | null {
  if (u.remaining === null) return null;
  const reset = resetPhrase(u, now);
  return `Il te reste ${countPhrase(u.remaining, u)}${reset ? ` · ${reset}` : ""}`;
}

/**
 * Ce qu'il restera APRÈS le lancement qu'on s'apprête à confirmer (devis MCP) :
 * « Après celle-ci, il te restera 2 examens QCM aujourd'hui (remise à 0 demain à 01:00) ».
 */
export function afterLine(u: KindUsage, now: string = new Date().toISOString()): string | null {
  if (u.remaining === null) return null;
  const reset = resetPhrase(u, now);
  return `Après celle-ci, il te restera ${countPhrase(Math.max(0, u.remaining - 1), u)}${reset ? ` (${reset})` : ""}`;
}
