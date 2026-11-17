import {
  CircleDashed,
  CircleDot,
  CheckCircle2,
  ShieldAlert,
  AlertTriangle,
  Info,
  XCircle,
  Eye,
  Loader,
  type LucideIcon,
} from "lucide-react";

export type Tone =
  | "neutral"
  | "accent"
  | "info"
  | "success"
  | "warning"
  | "danger";

/* ---- Mastery / type status (JAMAIS_VU · EN_COURS · SOLIDE) ---- */
export type Status = "JAMAIS_VU" | "EN_COURS" | "SOLIDE";

export const STATUS: Record<
  Status,
  { labelKey: "statusNeverSeen" | "statusInProgress" | "statusSolid"; tone: Tone; Icon: LucideIcon }
> = {
  JAMAIS_VU: { labelKey: "statusNeverSeen", tone: "neutral", Icon: CircleDashed },
  EN_COURS: { labelKey: "statusInProgress", tone: "info", Icon: CircleDot },
  SOLIDE: { labelKey: "statusSolid", tone: "success", Icon: CheckCircle2 },
};

/* ---- Weakness severity (GROS · MOYEN · LÉGER) ---- */
export type Severity = "GROS" | "MOYEN" | "LÉGER";

// REFONTE ALLÉGÉE : 3 niveaux SANS rouge dramatisant. GROS passe sur l'accent bleu (identité,
// « priorité haute » sans alarme) ; le sens reste porté par l'icône + la forme (SeverityMeter) + le
// libellé → colorblind-safe. MOYEN (ambre) et LÉGER (cyan) inchangés.
export const SEVERITY: Record<
  Severity,
  { labelKey: "severityHigh" | "severityMedium" | "severityLow"; tone: Tone; level: 1 | 2 | 3; Icon: LucideIcon }
> = {
  GROS: { labelKey: "severityHigh", tone: "accent", level: 3, Icon: ShieldAlert },
  MOYEN: { labelKey: "severityMedium", tone: "warning", level: 2, Icon: AlertTriangle },
  LÉGER: { labelKey: "severityLow", tone: "info", level: 1, Icon: Info },
};

/* ---- Weakness state (RATÉE · EN_COURS · VUE) ---- */
export type WState = "RATÉE" | "EN_COURS" | "VUE";

export const WSTATE: Record<WState, { labelKey: "weaknessFailed" | "weaknessInProgress" | "weaknessReviewed"; tone: Tone; Icon: LucideIcon }> = {
  RATÉE: { labelKey: "weaknessFailed", tone: "danger", Icon: XCircle },
  EN_COURS: { labelKey: "weaknessInProgress", tone: "info", Icon: Loader },
  VUE: { labelKey: "weaknessReviewed", tone: "success", Icon: Eye },
};

/** Tone → foreground text color (used for pills, icons, accents). */
export const toneText: Record<Tone, string> = {
  neutral: "text-ink-3",
  accent: "text-accent-hi",
  info: "text-cyan-hi",
  success: "text-emerald-hi",
  warning: "text-warning",
  danger: "text-danger-hi",
};

/** Tone → the raw token var (for SVG strokes / inline styles). */
export const toneVar: Record<Tone, string> = {
  neutral: "var(--color-ink-3)",
  accent: "var(--color-accent)",
  info: "var(--color-cyan)",
  success: "var(--color-emerald)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
};
