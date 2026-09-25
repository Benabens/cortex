"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, BookPlus, Check } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { useCourse } from "@/lib/ux/api";

const LANGUES: { value: string; label: string }[] = [
  { value: "fr", label: "Français" },
  { value: "en", label: "Anglais" },
  { value: "de", label: "Allemand" },
  { value: "it", label: "Italien" },
  { value: "es", label: "Espagnol" },
];

const field =
  "w-full rounded-lg border border-line-strong bg-surface-2/40 px-3 py-2.5 text-[0.88rem] text-ink-1 " +
  "placeholder:text-ink-4 focus:border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] focus:outline-none";

/**
 * CRÉER UN COURS — le geste qui manquait : plus aucune ligne de code ni de
 * terminal pour ajouter une matière. Seul le NOM est obligatoire ; le reste
 * n'habille que la page de garde des sujets générés. Le format, lui, se déduit
 * des annales importées ensuite (aucun profil à écrire).
 */
export function CourseForm() {
  const router = useRouter();
  const { refresh } = useCourse();
  const [form, setForm] = useState({
    name: "",
    code: "",
    university: "",
    teachers: "",
    language: "fr",
    examDate: "",
  });
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
        body: JSON.stringify(form),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? `Erreur ${res.status}`);
      setDone(true);
      // Recharge la liste ET bascule sur le cours neuf : l'utilisateur atterrit
      // sur Sources, l'écran depuis lequel il dépose ses annales.
      await refresh(d?.course?.id);
      router.push("/sources");
    } catch (err) {
      setError((err as Error).message || "La création a échoué.");
      setBusy(false);
    }
  };

  return (
    <Panel className="max-w-[40rem] p-5 sm:p-6">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <BookPlus className="size-4 text-violet-hi" strokeWidth={2.25} />
          <h2 className="text-[0.95rem] font-semibold text-ink-1">La matière</h2>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[0.82rem] font-medium text-ink-2">
            Nom du cours <span className="text-danger-hi">*</span>
          </span>
          <input
            value={form.name}
            onChange={set("name")}
            required
            maxLength={80}
            autoFocus
            placeholder="Analyse 3"
            className={field}
          />
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.82rem] font-medium text-ink-2">Code</span>
            <input value={form.code} onChange={set("code")} maxLength={24} placeholder="MATH-203" className={field} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.82rem] font-medium text-ink-2">Établissement</span>
            <input
              value={form.university}
              onChange={set("university")}
              maxLength={80}
              placeholder="EPFL"
              className={field}
            />
          </label>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[0.82rem] font-medium text-ink-2">Enseignant·es</span>
          <input
            value={form.teachers}
            onChange={set("teachers")}
            placeholder="Séparés par des virgules"
            className={field}
          />
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.82rem] font-medium text-ink-2">Langue</span>
            <select value={form.language} onChange={set("language")} className={field}>
              {LANGUES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[0.82rem] font-medium text-ink-2">Date de l’examen</span>
            <input type="date" value={form.examDate} onChange={set("examDate")} className={field} />
          </label>
        </div>

        <p className="text-[0.78rem] leading-relaxed text-ink-3">
          Ces informations n’habillent que la page de garde des sujets générés. Le format réel
          de l’épreuve, lui, sera déduit des annales que tu importeras à l’étape suivante.
        </p>

        {error && (
          <p role="alert" className="inline-flex items-start gap-1.5 text-[0.8rem] text-danger-hi">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.25} />
            {error}
          </p>
        )}
        {done && !error && (
          <p className="inline-flex items-center gap-1.5 text-[0.8rem] text-emerald-hi" aria-live="polite">
            <Check className="size-4" strokeWidth={2.5} />
            Cours créé — direction l’import des annales.
          </p>
        )}

        <div className="flex flex-wrap gap-2.5 border-t border-line pt-4">
          <Button type="submit" variant="primary" loading={busy} disabled={!form.name.trim()}>
            Créer le cours
          </Button>
          <Button type="button" variant="ghost" onClick={() => router.back()} disabled={busy}>
            Annuler
          </Button>
        </div>
      </form>
    </Panel>
  );
}
