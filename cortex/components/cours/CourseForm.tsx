"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { useCourse } from "@/lib/ux/api";
import { EMPTY_FORMAT, ExamFormatFields, formatPayload, type ExamFormatDraft } from "@/components/cours/ExamFormatFields";
import { useTranslations } from "use-intl/react";

const field =
  "w-full rounded-lg border border-line-strong bg-surface-2/40 px-3 py-2.5 text-[0.88rem] text-ink-1 " +
  "placeholder:text-ink-4 focus:border-[color-mix(in_oklch,var(--color-accent)_50%,transparent)] focus:outline-none";

/**
 * CRÉER UN COURS — le geste qui manquait : plus aucune ligne de code ni de
 * terminal pour ajouter une matière. Seul le NOM est obligatoire. Le format de
 * l'épreuve se déduit des annales importées ensuite ; sans annale, celui déclaré
 * ici (type, nombre de questions, durée, langue) est le seul que Cortex suit.
 */
export function CourseForm() {
  const t = useTranslations("courseForm");
  // « auto » : la langue se détecte sur les annales puis les supports importés (lib/exam-format).
  const languages = [
    { value: "auto", label: t("languageAuto") },
    { value: "fr", label: t("languageFr") },
    { value: "en", label: t("languageEn") },
    { value: "de", label: t("languageDe") },
    { value: "it", label: t("languageIt") },
    { value: "es", label: t("languageEs") },
    { value: "pt", label: t("languagePt") },
    { value: "nl", label: t("languageNl") },
  ];
  const router = useRouter();
  const { refresh } = useCourse();
  const [form, setForm] = useState({
    name: "",
    code: "",
    university: "",
    teachers: "",
    language: "auto",
    examDate: "",
  });
  const [format, setFormat] = useState<ExamFormatDraft>(EMPTY_FORMAT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !form.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, examFormat: formatPayload(format) }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? t("errorStatus", { status: res.status }));
      setDone(true);
      // Recharge la liste ET bascule sur le cours neuf : l'utilisateur atterrit
      // sur Sources, l'écran depuis lequel il dépose ses annales.
      await refresh(d?.course?.id);
      router.push("/sources");
    } catch (err) {
      setError((err as Error).message || t("createFailed"));
      setBusy(false);
    }
  };

  return (
    <Panel className="max-w-[40rem] p-5 sm:p-6">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <h2 className="text-[0.95rem] font-semibold text-ink-1">{t("section")}</h2>

        <label className="flex flex-col gap-1.5">
          <span className="text-[0.82rem] font-medium text-ink-2">
            {t("name")} <span className="text-danger-hi">*</span>
          </span>
          <input
            value={form.name}
            onChange={set("name")}
            required
            maxLength={80}
            autoFocus
            placeholder={t("namePlaceholder")}
            className={field}
          />
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.82rem] font-medium text-ink-2">{t("code")}</span>
            <input value={form.code} onChange={set("code")} maxLength={24} placeholder={t("codePlaceholder")} className={field} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.82rem] font-medium text-ink-2">{t("institution")}</span>
            <input
              value={form.university}
              onChange={set("university")}
              maxLength={80}
              placeholder={t("institutionPlaceholder")}
              className={field}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[0.82rem] font-medium text-ink-2">{t("teachers")}</span>
          <input
            value={form.teachers}
            onChange={set("teachers")}
            placeholder={t("teachersPlaceholder")}
            className={field}
          />
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.82rem] font-medium text-ink-2">{t("language")}</span>
            <select value={form.language} onChange={set("language")} className={field}>
              {languages.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.82rem] font-medium text-ink-2">{t("examDate")}</span>
            <input type="date" value={form.examDate} onChange={set("examDate")} className={field} />
          </label>
        </div>

        <p className="text-[0.78rem] leading-relaxed text-ink-3">
          {t("coverHint")}
        </p>

        <ExamFormatFields value={format} onChange={setFormat} fieldClass={field} />

        {error && (
          <p role="alert" className="inline-flex items-start gap-1.5 text-[0.8rem] text-danger-hi">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.25} />
            {error}
          </p>
        )}
        {done && !error && (
          <p className="inline-flex items-center gap-1.5 text-[0.8rem] text-emerald-hi" aria-live="polite">
            <Check className="size-4" strokeWidth={2.5} />
            {t("created")}
          </p>
        )}

        <div className="flex flex-wrap gap-2.5 border-t border-line pt-4">
          <Button type="submit" variant="primary" loading={busy} disabled={!form.name.trim()}>
            {t("create")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.back()} disabled={busy}>
            {t("cancel")}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
