"use client";

/**
 * FORMAT DE L'ÉPREUVE — déclaré par l'étudiant à la création ou à l'édition d'un
 * cours. C'est la seule source de format d'un cours sans annale : sans lui (et sans
 * questions d'exemple ni consignes dans les sources), Cortex refuse de générer un
 * examen blanc plutôt que d'en inventer la forme. Des annales, quand elles existent,
 * restent prioritaires.
 */

import type { AnswerMode, DocumentRule } from "@/lib/exam-format";
import { useTranslations } from "use-intl/react";

export type ExamFormatDraft = { kind: string; questionCount: string; durationMin: string; language: string; answerMode: string; documents: string };

export type DeclaredFormatDto = { kind: string; questionCount: number | null; durationMin: number | null; language: string | null; answerMode?: AnswerMode; documents?: DocumentRule };

export const EMPTY_FORMAT: ExamFormatDraft = { kind: "", questionCount: "", durationMin: "", language: "", answerMode: "", documents: "" };

const hasChoices = (kind: string) => kind === "qcm" || kind === "mixed";

export function formatDraftOf(f: DeclaredFormatDto | null | undefined): ExamFormatDraft {
  if (!f) return EMPTY_FORMAT;
  return {
    kind: f.kind,
    questionCount: f.questionCount ? String(f.questionCount) : "",
    durationMin: f.durationMin ? String(f.durationMin) : "",
    language: f.language ?? "",
    answerMode: f.answerMode ?? "",
    documents: f.documents ?? "",
  };
}

/** Corps envoyé à l'API : null = rien de déclaré. */
export function formatPayload(d: ExamFormatDraft): DeclaredFormatDto | null {
  if (!d.kind) return null;
  const n = (s: string) => (s.trim() ? Number(s) : null);
  return {
    kind: d.kind, questionCount: n(d.questionCount), durationMin: n(d.durationMin), language: d.language || null,
    ...(hasChoices(d.kind) && d.answerMode ? { answerMode: d.answerMode as AnswerMode } : {}),
    ...(d.documents ? { documents: d.documents as DocumentRule } : {}),
  };
}

export function ExamFormatFields({
  value,
  onChange,
  fieldClass,
}: {
  value: ExamFormatDraft;
  onChange: (next: ExamFormatDraft) => void;
  fieldClass: string;
}) {
  const t = useTranslations("examFormat");
  const kinds = [
    { value: "", label: t("kindUnknown") }, { value: "qcm", label: t("kindQcm") },
    { value: "exercises", label: t("kindExercises") }, { value: "mixed", label: t("kindMixed") },
    { value: "composite", label: t("kindComposite") }, { value: "essay", label: t("kindEssay") },
    { value: "oral", label: t("kindOral") },
  ];
  const answers: { value: "" | AnswerMode; label: string }[] = [
    { value: "", label: t("answerUnknown") }, { value: "single", label: t("answerSingle") },
    { value: "multiple", label: t("answerMultiple") }, { value: "mixed", label: t("answerMixed") },
  ];
  const documents: { value: "" | DocumentRule; label: string }[] = [
    { value: "", label: t("documentsUnknown") }, { value: "none", label: t("documentsNone") },
    { value: "notes", label: t("documentsNotes") }, { value: "open", label: t("documentsOpen") },
  ];
  const languages = [
    { value: "", label: t("languageCourse") }, { value: "fr", label: t("languageFr") },
    { value: "en", label: t("languageEn") }, { value: "de", label: t("languageDe") },
    { value: "it", label: t("languageIt") }, { value: "es", label: t("languageEs") },
  ];
  const set = (k: keyof ExamFormatDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    onChange({ ...value, [k]: e.target.value });
  const choices = hasChoices(value.kind);

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-[0.82rem] font-medium text-ink-2">{t("legend")}</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.78rem] text-ink-3">{t("type")}</span>
          <select value={value.kind} onChange={set("kind")} className={fieldClass}>
            {kinds.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.78rem] text-ink-3">{choices ? t("questionCount") : t("subjectCount")}</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={200}
            value={value.questionCount}
            onChange={set("questionCount")}
            disabled={!value.kind}
            placeholder={choices ? "20" : "4"}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.78rem] text-ink-3">{t("duration")}</span>
          <input
            type="number"
            inputMode="numeric"
            min={5}
            max={600}
            value={value.durationMin}
            onChange={set("durationMin")}
            disabled={!value.kind}
            placeholder="45"
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.78rem] text-ink-3">{t("language")}</span>
          <select value={value.language} onChange={set("language")} disabled={!value.kind} className={fieldClass}>
            {languages.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.78rem] text-ink-3">{t("documents")}</span>
          <select value={value.documents} onChange={set("documents")} disabled={!value.kind} className={fieldClass}>
            {documents.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </label>
        {choices && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.78rem] text-ink-3">{t("answers")}</span>
            <select value={value.answerMode} onChange={set("answerMode")} className={fieldClass}>
              {answers.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="text-[0.76rem] leading-relaxed text-ink-3">
        {t("hint")}
      </p>
    </fieldset>
  );
}
