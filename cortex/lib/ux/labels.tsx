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
  | "violet"
  | "info"
  | "success"
  | "warning"
  | "danger";

/* ---- Mastery / type status (JAMAIS_VU · EN_COURS · SOLIDE) ---- */
export type Status = "JAMAIS_VU" | "EN_COURS" | "SOLIDE";

export const STATUS: Record<
  Status,
  { label: string; tone: Tone; Icon: LucideIcon }
> = {
  JAMAIS_VU: { label: "Jamais vu", tone: "neutral", Icon: CircleDashed },
  EN_COURS: { label: "En cours", tone: "info", Icon: CircleDot },
  SOLIDE: { label: "Solide", tone: "success", Icon: CheckCircle2 },
};

/* ---- Weakness severity (GROS · MOYEN · LÉGER) ---- */
export type Severity = "GROS" | "MOYEN" | "LÉGER";

export const SEVERITY: Record<
  Severity,
  { label: string; tone: Tone; level: 1 | 2 | 3; Icon: LucideIcon }
> = {
  GROS: { label: "Sévère", tone: "danger", level: 3, Icon: ShieldAlert },
  MOYEN: { label: "Moyen", tone: "warning", level: 2, Icon: AlertTriangle },
  LÉGER: { label: "Léger", tone: "info", level: 1, Icon: Info },
};

/* ---- Weakness state (RATÉE · EN_COURS · VUE) ---- */
export type WState = "RATÉE" | "EN_COURS" | "VUE";

export const WSTATE: Record<WState, { label: string; tone: Tone; Icon: LucideIcon }> = {
  RATÉE: { label: "Ratée", tone: "danger", Icon: XCircle },
  EN_COURS: { label: "En cours", tone: "info", Icon: Loader },
  VUE: { label: "Revue", tone: "success", Icon: Eye },
};

/** Tone → foreground text color (used for pills, icons, accents). */
export const toneText: Record<Tone, string> = {
  neutral: "text-ink-3",
  violet: "text-violet-hi",
  info: "text-cyan-hi",
  success: "text-emerald-hi",
  warning: "text-warning",
  danger: "text-danger-hi",
};

/** Tone → the raw token var (for SVG strokes / inline styles). */
export const toneVar: Record<Tone, string> = {
  neutral: "var(--color-ink-3)",
  violet: "var(--color-violet)",
  info: "var(--color-cyan)",
  success: "var(--color-emerald)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
};
