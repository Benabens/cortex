"use client";

/**
 * FORMAT DE L'ÉPREUVE — déclaré par l'étudiant à la création ou à l'édition d'un
 * cours. C'est la seule source de format d'un cours sans annale : sans lui (et sans
 * questions d'exemple ni consignes dans les sources), Cortex refuse de générer un
 * examen blanc plutôt que d'en inventer la forme. Des annales, quand elles existent,
 * restent prioritaires.
 */

export type ExamFormatDraft = { kind: string; questionCount: string; durationMin: string; language: string };

export type DeclaredFormatDto = { kind: string; questionCount: number | null; durationMin: number | null; language: string | null };

export const EMPTY_FORMAT: ExamFormatDraft = { kind: "", questionCount: "", durationMin: "", language: "" };

const KINDS: { value: string; label: string }[] = [
  { value: "", label: "Je ne sais pas encore" },
  { value: "qcm", label: "QCM" },
  { value: "exercises", label: "Exercices / problèmes" },
  { value: "mixed", label: "QCM + questions ouvertes" },
  { value: "essay", label: "Essai / dissertation" },
  { value: "oral", label: "Oral" },
];

const LANGUES: { value: string; label: string }[] = [
  { value: "", label: "Celle du cours" },
  { value: "fr", label: "Français" },
  { value: "en", label: "Anglais" },
  { value: "de", label: "Allemand" },
  { value: "it", label: "Italien" },
  { value: "es", label: "Espagnol" },
];

export function formatDraftOf(f: DeclaredFormatDto | null | undefined): ExamFormatDraft {
  if (!f) return EMPTY_FORMAT;
  return {
    kind: f.kind,
    questionCount: f.questionCount ? String(f.questionCount) : "",
    durationMin: f.durationMin ? String(f.durationMin) : "",
    language: f.language ?? "",
  };
}

/** Corps envoyé à l'API : null = rien de déclaré. */
export function formatPayload(d: ExamFormatDraft): DeclaredFormatDto | null {
  if (!d.kind) return null;
  const n = (s: string) => (s.trim() ? Number(s) : null);
  return { kind: d.kind, questionCount: n(d.questionCount), durationMin: n(d.durationMin), language: d.language || null };
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
  const set = (k: keyof ExamFormatDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    onChange({ ...value, [k]: e.target.value });
  const counted = value.kind === "qcm" || value.kind === "mixed";

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-[0.82rem] font-medium text-ink-2">Format de l’épreuve</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.78rem] text-ink-3">Type</span>
          <select value={value.kind} onChange={set("kind")} className={fieldClass}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>{k.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.78rem] text-ink-3">{counted ? "Nombre de questions" : "Nombre d’exercices ou de sujets"}</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={200}
            value={value.questionCount}
            onChange={set("questionCount")}
            disabled={!value.kind}
            placeholder={counted ? "20" : "4"}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.78rem] text-ink-3">Durée (minutes)</span>
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
          <span className="text-[0.78rem] text-ink-3">Langue de l’examen</span>
          <select value={value.language} onChange={set("language")} disabled={!value.kind} className={fieldClass}>
            {LANGUES.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-[0.76rem] leading-relaxed text-ink-3">
        Sans annale, c’est ce format que suivent tes examens blancs. Des annales importées, elles, priment.
        Si tu ne le connais pas, Cortex le cherche dans tes sources (questions d’exemple, consignes) et te le
        demandera plutôt que de l’inventer.
      </p>
    </fieldset>
  );
}
