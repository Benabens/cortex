"use client";

import { useState } from "react";
import { Pencil, Trash2, X, Check, AlertTriangle, BookPlus } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { useCourse, type CourseInfo } from "@/lib/ux/api";

const field =
  "w-full rounded-lg border border-line-strong bg-surface-2/40 px-3 py-2 text-[0.85rem] text-ink-1 " +
  "placeholder:text-ink-4 focus:border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] focus:outline-none";

/**
 * MES COURS — renommer et retirer. Le retrait ne supprime QUE la fiche : le
 * corpus, les examens générés et les faiblesses restent dans le tenant et sur
 * le volume. On le dit explicitement plutôt que de laisser croire à un effacement.
 */
export function CourseList() {
  const { courses, courseId, refresh } = useCourse();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", code: "", university: "" });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startEdit = (c: CourseInfo) => {
    setError(null);
    setConfirming(null);
    setEditing(c.id);
    setDraft({ name: c.name, code: c.code, university: c.university });
  };

  const save = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/courses/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? `Erreur ${res.status}`);
      setEditing(null);
      await refresh(courseId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/courses/${encodeURIComponent(id)}`, { method: "DELETE" });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? `Erreur ${res.status}`);
      setConfirming(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!courses.length) {
    return (
      <Panel className="flex flex-col items-center gap-3 rounded-xl px-6 py-12 text-center">
        <BookPlus className="size-6 text-violet-hi" strokeWidth={2} aria-hidden="true" />
        <p className="text-[0.95rem] font-medium text-ink-1">Aucun cours pour l’instant</p>
        <Button variant="primary" size="sm" href="/cours/nouveau">
          Créer ma première matière
        </Button>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="inline-flex items-start gap-1.5 text-[0.8rem] text-danger-hi">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.25} />
          {error}
        </p>
      )}

      {courses.map((c) => (
        <Panel key={c.id} className="p-4">
          {editing === c.id ? (
            <div className="flex flex-col gap-3">
              <input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                aria-label="Nom du cours"
                className={field}
              />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <input
                  value={draft.code}
                  onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))}
                  placeholder="Code"
                  aria-label="Code du cours"
                  className={field}
                />
                <input
                  value={draft.university}
                  onChange={(e) => setDraft((d) => ({ ...d, university: e.target.value }))}
                  placeholder="Établissement"
                  aria-label="Établissement"
                  className={field}
                />
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="primary" loading={busy} onClick={() => save(c.id)}>
                  <Check className="size-4" strokeWidth={2.5} />
                  Enregistrer
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
                  Annuler
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.9rem] font-semibold text-ink-1">{c.name}</p>
                <p className="mt-0.5 truncate text-[0.78rem] text-ink-3">
                  {[c.code, c.university].filter(Boolean).join(" · ") || "Sans code ni établissement"}
                  <span className="text-ink-4"> · {c.id}</span>
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="subtle" onClick={() => startEdit(c)} aria-label={`Modifier ${c.name}`}>
                  <Pencil className="size-3.5" strokeWidth={2.25} />
                  Modifier
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setError(null); setEditing(null); setConfirming(confirming === c.id ? null : c.id); }}
                  aria-label={`Retirer ${c.name}`}
                >
                  {confirming === c.id ? <X className="size-3.5" strokeWidth={2.25} /> : <Trash2 className="size-3.5" strokeWidth={2.25} />}
                  {confirming === c.id ? "Annuler" : "Retirer"}
                </Button>
              </div>
            </div>
          )}

          {confirming === c.id && (
            <div className="mt-3 rounded-lg border border-line bg-surface-2/40 p-3">
              <p className="text-[0.82rem] leading-relaxed text-ink-2">
                Retirer <strong className="text-ink-1">{c.name}</strong> de ta liste ? Ses données
                (corpus, annales, examens générés, faiblesses) ne sont <strong>pas</strong> effacées —
                elles restent en place et un cours recréé sous le même identifiant les retrouverait.
              </p>
              <Button size="sm" variant="secondary" className="mt-3" loading={busy} onClick={() => remove(c.id)}>
                <Trash2 className="size-3.5" strokeWidth={2.25} />
                Retirer le cours
              </Button>
            </div>
          )}
        </Panel>
      ))}
    </div>
  );
}
