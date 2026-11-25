/**
 * Résumé lisible d'un examen QCM (« 16 QCM vérifiés · 2 questions ouvertes »). Module pur :
 * écrit en base par lib/qcm à la génération ; les lecteurs (lib/exam, lib/qcm, lib/blocks)
 * passent la valeur lue par `examSummaryLabel`, pour l'écran comme pour le connecteur MCP.
 *
 * Les examens générés avant le 13/11/2026 portent l'ancien format abrégé
 * (« QCM 16 (16 vér.) + 2 ouverte(s) — … ») : `examSummaryLabel` le réécrit à l'affichage.
 * Examen écrit : la base garde le rapport du moteur (« ok=4 corrigés=0 durcis=0 retirés=0
 * non-vérifiés=0 »), qui s'affichait tel quel sur la carte d'examen prêt. `examSummaryLabel` le
 * remplace par le compte des exercices vérifiés de l'examen, dans la langue du lecteur.
 */
import { currentLocale } from "@/lib/i18n/current";
import type { Locale } from "@/lib/i18n/locale";
import { translator } from "@/lib/i18n/translate";

export type QcmSummaryCounts = {
  count: number;
  requested: number;
  verified: number;
  open: number;
  openRequested: number;
};

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

const verifiedPart = (n: number) => (n > 0 ? plural(n, "vérifié", "vérifiés") : "aucun vérifié");

export function qcmSummaryText(r: QcmSummaryCounts): string {
  const qcm =
    r.count < r.requested
      ? `QCM : ${r.count} sur ${r.requested} demandés, dont ${verifiedPart(r.verified)}`
      : r.verified >= r.count
        ? `${r.count} QCM ${r.count > 1 ? "vérifiés" : "vérifié"}`
        : `${r.count} QCM, dont ${verifiedPart(r.verified)}`;
  if (!r.open && !r.openRequested) return qcm;
  const open = plural(r.open, "question ouverte", "questions ouvertes");
  return `${qcm} · ${r.open < r.openRequested ? `${open} sur ${r.openRequested}` : open}`;
}

/** Exercices d'un examen écrit (exam_questions.verified) : vérifiés, et en tout. */
export type WrittenVerifyCounts = { verified: number; total: number };

/** « 4 exercices vérifiés », « 3 exercices vérifiés sur 4 », « 4 exercices non vérifiés », dans la langue du lecteur ; sans exercice : null. */
export function writtenSummaryText(c: WrittenVerifyCounts, locale: Locale = currentLocale()): string | null {
  if (c.total <= 0) return null;
  const t = translator(locale);
  if (c.verified >= c.total) return t("examSummary.writtenAll", { count: c.total });
  if (c.verified <= 0) return t("examSummary.writtenNone", { count: c.total });
  return t("examSummary.writtenPart", { verified: c.verified, total: c.total });
}

/** Rapport du moteur rangé pour un examen écrit (lib/exam) : il ne s'affiche jamais tel quel. */
const WRITTEN_REPORT = /^ok=\d+ corrigés=\d+ durcis=\d+(?: retirés=\d+)?(?: non-vérifiés=\d+)?$/;

const LEGACY_QCM = /^QCM (\d+)(?: sur (\d+) demandés)? \((\d+) vér\.\) \+ (\d+)(?: sur (\d+))? ouverte\(s\)/;

/**
 * `written` : le compte des exercices d'un examen écrit, lu par l'appelant. Le rapport du moteur ne
 * le donne pas (un exercice corrigé puis durci y compte deux fois) : sans lui, rien plutôt qu'un
 * chiffre faux. `locale` ne sert qu'à cette phrase ; celle d'un QCM est encore en français.
 */
export function examSummaryLabel(raw: string | null, locale: Locale = currentLocale(), written?: WrittenVerifyCounts): string | null {
  if (!raw) return raw;
  if (WRITTEN_REPORT.test(raw.trim())) return written ? writtenSummaryText(written, locale) : null;
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
