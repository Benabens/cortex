/**
 * Résumé lisible d'un examen QCM (« 16 QCM vérifiés · 2 questions ouvertes »). Module pur :
 * écrit en base par lib/qcm à la génération, et relu par l'écran Examens.
 *
 * Les examens générés avant le 13/11/2026 portent l'ancien format abrégé
 * (« QCM 16 (16 vér.) + 2 ouverte(s) — … ») : `examSummaryLabel` le réécrit à l'affichage.
 */

export type QcmSummaryCounts = {
  count: number;
  requested: number;
  verified: number;
  open: number;
  openRequested: number;
};

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

export function qcmSummaryText(r: QcmSummaryCounts): string {
  const qcm =
    r.count < r.requested
      ? `QCM : ${r.count} sur ${r.requested} demandés, dont ${r.verified} vérifiés`
      : r.verified >= r.count
        ? `${r.count} QCM vérifiés`
        : `${r.count} QCM dont ${r.verified} vérifiés`;
  if (!r.open && !r.openRequested) return qcm;
  const open = plural(r.open, "question ouverte", "questions ouvertes");
  return `${qcm} · ${r.open < r.openRequested ? `${open} sur ${r.openRequested}` : open}`;
}

const LEGACY_QCM = /^QCM (\d+)(?: sur (\d+) demandés)? \((\d+) vér\.\) \+ (\d+)(?: sur (\d+))? ouverte\(s\)/;

export function examSummaryLabel(raw: string | null): string | null {
  if (!raw) return raw;
  const m = LEGACY_QCM.exec(raw);
  const text = m
    ? qcmSummaryText({
        count: Number(m[1]),
        requested: Number(m[2] ?? m[1]),
        verified: Number(m[3]),
        open: Number(m[4]),
        openRequested: Number(m[5] ?? m[4]),
      }) + raw.slice(m[0].length)
    : raw;
  return text.replace(/\s+[—–]\s+/g, ", ");
}
