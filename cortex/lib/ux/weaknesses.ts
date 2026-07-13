/**
 * Types Faiblesses — formes réelles de GET /api/weaknesses (confirmées par curl).
 */

import type { Severity } from "@/lib/ux/labels";

export type Weakness = {
  id: number;
  topic: string;
  description: string | null;
  screenshotPath: string | null;
  screenshotUrl: string | null;
  severity: number; // 1–3
  analyzed: boolean;
  source: string; // "manual" | "conversation" | …
  theme: string | null;
  timesSeen: number;
  loggedAt: string | null;
  lastReviewedAt: string | null;
  related: unknown[];
};

export type WeaknessesResp = {
  weaknesses: Weakness[];
  byTheme: { theme: string; count: number; avgSeverity: number; topics: string[] }[];
};

/** Résultat de POST /api/weaknesses/mine (import de discussion). */
export type MinedItem = {
  topic: string;
  concept: string;
  severity: number;
  theme?: string | null;
  excerpt?: string | null;
};
export type MineResp = {
  created: number;
  mined?: MinedItem[];
  weaknesses: Weakness[];
  note?: string;
};

export function sevOf(level: number): Severity {
  if (level >= 3) return "GROS";
  if (level === 2) return "MOYEN";
  return "LÉGER";
}

/** Libellé de provenance lisible. */
export function sourceLabel(source: string): string {
  switch (source) {
    case "conversation":
      return "Discussion importée";
    case "manual":
      return "Ajout manuel";
    case "screenshot":
      return "Screenshot";
    default:
      return source;
  }
}

/** Chips « relié au corpus » — ne rend que ce qui est affichable. */
export function relatedChips(related: unknown[]): string[] {
  return (related ?? [])
    .map((r) => {
      if (typeof r === "string") return r;
      if (r && typeof r === "object") {
        const o = r as Record<string, unknown>;
        if (typeof o.label === "string") return o.label;
        if (typeof o.title === "string") return o.title;
      }
      return null;
    })
    .filter((s): s is string => !!s)
    .slice(0, 4);
}
