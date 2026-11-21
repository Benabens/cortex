"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { FileText, FileCode2, Layers, Check, Trash2, ArrowUpRight } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { apiPost, useCourse, useJob } from "@/lib/ux/api";
import { corpusLabel, extOf, type SourcesResp, type SourceExam } from "@/lib/ux/sources";
import { cn } from "@/lib/ux/cn";
import { apiDelete } from "@/lib/ux/write";
import { OnComputerBadge } from "@/components/sources/OriginalsNotes";
import { useTranslations } from "use-intl/react";

const ANNALE_TYPES = new Set(["final", "midterm"]);
/** Valeur de la facette par défaut (les annales regroupent plusieurs types de source). */
const ANNALES = "__annales__";
// ordre d'affichage préféré des facettes non-annales
const FACET_ORDER = ["course_pdf", "lecture", "serie", "exercise", "cheatsheet", "review", "note", "code", "lab", "doc"];
const JOB_RUNNING = new Set(["queued", "running", "verifying", "compiling"]);

type ExamKind = "final" | "midterm";
/** Fichier en cours de reclassement : son chemin, son titre, et ce que le formulaire propose. */
type Classifying = { path: string; title: string; kind: ExamKind; year: number | null; edit: boolean };

/**
 * Suivi d'un reclassement : le message annoncé et le job d'ingestion qui réindexe le corpus. Tenu
 * par la page, pas par la liste : le rechargement de la liste la démonte le temps de la requête.
 */
export type Reindex = { notice: string | null; running: boolean; start: (notice: string, jobId: number | null) => void };

export function useReindex(refetch: () => void): Reindex {
  const t = useTranslations("fileManager");
  const [notice, setNotice] = useState<string | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const job = useJob(jobId);

  // Fin du job : la liste se recharge depuis le corpus refait.
  useEffect(() => {
    if (!job || JOB_RUNNING.has(job.status)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- la fin du job (état externe) ferme le suivi
    setJobId(null);
    setNotice(job.status === "done" ? t("classifyDone") : null);
    refetch();
  }, [job, refetch, t]);

  const start = useCallback((msg: string, id: number | null) => {
    setNotice(msg);
    setJobId(id);
    if (id == null) refetch();
  }, [refetch]);
  return { notice, running: jobId != null, start };
}

/** Type et année d'une annale devinés du titre, à corriger par l'étudiant. */
function guessExam(title: string): { kind: ExamKind; year: number | null } {
  const year = title.match(/\b(19|20)\d{2}\b/)?.[0];
  return { kind: /midterm|partiel|mid-?term|interm/i.test(title) ? "midterm" : "final", year: year ? Number(year) : null };
}

const ACTION_BTN =
  "inline-flex min-h-11 shrink-0 items-center rounded-md border border-line px-2.5 text-[0.78rem] font-medium text-ink-2 transition-colors hover:border-[color-mix(in_oklch,var(--color-accent)_40%,transparent)] hover:text-accent-hi focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:opacity-40";

/**
 * Corpus RÉEL du cours. Les FACETTES sont cliquables (RUN v2) : « Annales » (défaut, avec cases
 * « Référence ») + un chip par type de corpus (Cours / Séries / Exercices / Cheat sheets…) qui
 * FILTRE la liste et permet d'OUVRIR chaque item via le deep-link « voir ». Le format des blancs
 * se cale sur les annales cochées. Bascule « Référence » optimiste → aucun saut de ligne.
 */
export function FileManager({ data, onChanged, reindex }: { data: SourcesResp; onChanged: () => void; reindex: Reindex }) {
  const t = useTranslations("fileManager");
  const { courseId } = useCourse();
  const [facet, setFacet] = useState<string | null>(null); // null = Annales (défaut)
  const [pending, setPending] = useState<Record<string, boolean>>({}); // path → isReference optimiste
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Reclassement (annale ↔ support) : formulaire ouvert et erreur ; le suivi du job est dans `reindex`.
  const [classifying, setClassifying] = useState<Classifying | null>(null);
  const [classifyError, setClassifyError] = useState<string | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement | null>());
  const reindexing = reindex.running;

  // données fraîches (après un vrai refetch, ex. upload/suppression) → on efface les surcharges.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- une réponse fraîche invalide les surcharges optimistes
    setPending({});
  }, [data]);

  const isRef = (f: SourceExam) => pending[f.path] ?? f.isReference;
  const setBusyFor = (path: string, on: boolean) =>
    setBusy((s) => { const n = new Set(s); if (on) n.add(path); else n.delete(path); return n; });

  // Originaux restés sur l'ordinateur d'un compte gratuit (lib/originals) : Cortex n'a que leur index.
  const onComputer = useMemo(() => new Set(data.originals?.onComputer ?? []), [data.originals]);
  const hrefByPath = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const s of data.sources ?? []) m.set(s.path, s.href);
    return m;
  }, [data.sources]);

  const toggleRef = async (f: SourceExam) => {
    const next = !isRef(f);
    setPending((p) => ({ ...p, [f.path]: next }));
    setBusyFor(f.path, true);
    try {
      // On NE refetch PAS : l'état optimiste fait foi côté UI, le POST persiste côté serveur.
      // → la liste ne se remonte plus, la ligne ne saute plus (fix jank).
      await apiPost("/api/sources", courseId, { path: f.path, reference: next }, (status) => String(status)); // message jamais affiché : rollback seul
    } catch {
      setPending((p) => ({ ...p, [f.path]: !next })); // rollback
    } finally {
      setBusyFor(f.path, false);
    }
  };

  const remove = async (f: SourceExam) => {
    if (!window.confirm(t("removeConfirm", { title: f.title }))) return;
    setBusyFor(f.path, true);
    setRemoveError(null);
    try {
      await apiDelete(`/api/sources?path=${encodeURIComponent(f.path)}&course=${encodeURIComponent(courseId)}`);
      onChanged();
    } catch (e) {
      setRemoveError((e as Error).message);
    } finally {
      setBusyFor(f.path, false);
    }
  };

  const closeForm = (path: string) => {
    setClassifying(null);
    // Le focus revient au bouton qui a ouvert le formulaire (WCAG 2.4.3).
    requestAnimationFrame(() => triggers.current.get(path)?.focus());
  };

  const classify = async (path: string, title: string, body: { as: "support" } | { as: "exam"; kind: ExamKind; year: number | null }) => {
    setBusyFor(path, true);
    setClassifyError(null);
    try {
      const r = await apiPost<{ jobId: number | null }>("/api/sources/classify", courseId, { path, ...body }, (status) => String(status));
      setClassifying(null);
      reindex.start(t(body.as === "exam" ? "classifiedExam" : "classifiedSupport", { title }), r.jobId);
    } catch (e) {
      setClassifyError(t("classifyFailed", { error: (e as Error).message }));
    } finally {
      setBusyFor(path, false);
    }
  };

  const openForm = (c: Classifying) => {
    setClassifyError(null);
    setClassifying(c);
  };
  const triggerRef = (path: string) => (el: HTMLButtonElement | null) => { triggers.current.set(path, el); };
  /** Le formulaire de type et d'année, sous le fichier dont il est ouvert. */
  const formFor = (path: string, title: string) => classifying?.path === path && (
    <ClassifyForm
      initial={classifying}
      busy={busy.has(path)}
      onCancel={() => closeForm(path)}
      onSubmit={(kind, year) => classify(path, title, { as: "exam", kind, year })}
    />
  );

  // Facettes : « Annales » + types de corpus non-annales présents (dans l'ordre préféré).
  const nonAnnaleTypes = (data.corpus ?? [])
    .filter((c) => !ANNALE_TYPES.has(c.type))
    .sort((a, b) => (FACET_ORDER.indexOf(a.type) + 1 || 99) - (FACET_ORDER.indexOf(b.type) + 1 || 99));
  const annaleCount = data.exams.length;
  // Compteur global en FICHIERS (« extraits » ne parlait pas aux étudiants : série 3).
  const totalFiles = data.corpus.reduce((a, c) => a + c.sources, 0);
  const refCount = data.exams.filter((e) => isRef(e)).length;

  const browseRows = facet ? (data.sources ?? []).filter((s) => s.type === facet) : [];

  return (
    <Panel className="overflow-hidden p-0">
      {classifyError && (
        <p role="alert" className="border-b border-line px-4 py-2.5 text-[0.82rem] text-danger-hi">
          {classifyError}
        </p>
      )}
      {removeError && (
        <p role="alert" className="border-b border-line px-4 py-2.5 text-[0.82rem] text-danger-hi">
          {t("removeFailed", { error: removeError })}
        </p>
      )}
      {/* résumé + FACETTES cliquables */}
      <div className="border-b border-line px-6 py-5">
        <div className="flex items-center gap-2 text-[0.76rem] text-ink-3">
          <Layers className="size-3.5" strokeWidth={2} />
          <span>{t("fileCount", { count: totalFiles })}</span>
        </div>
        <Segmented
          variant="chips"
          className="mt-3"
          label={t("fileTypes")}
          options={[
            { value: ANNALES, label: t("pastExams"), count: annaleCount },
            ...nonAnnaleTypes.map((c) => ({ value: c.type, label: corpusLabel(c.type, t), count: c.sources })),
          ]}
          value={facet ?? ANNALES}
          onChange={(v) => setFacet(v === ANNALES ? null : v)}
        />
      </div>

      {facet === null ? (
        <>
          {/* en-tête table annales (desktop) */}
          <div className="hidden items-center gap-3 border-b border-line px-4 py-2 text-xs font-medium text-ink-4 md:flex">
            <span className="w-8" />
            <span className="flex-1">{t("pastExam")}</span>
            <span className="pr-14 text-right">{t("viewReference")}</span>
          </div>

          <div className="divide-y divide-line px-1.5">
            {data.exams.map((f) => {
              const ext = extOf(f.path);
              const Icon = ext === "HTML" || ext === "HTM" ? FileCode2 : FileText;
              const isBusy = busy.has(f.path);
              const href = hrefByPath.get(f.path) ?? null;
              return (
                <div key={f.path} className="flex flex-wrap items-center gap-3 px-4 py-4 transition-colors hover:bg-surface-2/40">
                  <span className="grid size-8 shrink-0 place-items-center rounded-md border border-line bg-surface-2/60 text-ink-3">
                    <Icon className="size-4" strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[0.88rem] text-ink-1" title={f.title}>
                      {f.title}
                      {f.year ? <span className="ml-1.5 text-ink-3">· {f.year}</span> : null}
                    </div>
                    <div className="text-[0.72rem] text-ink-4">
                      <span className="font-data">{ext}</span>
                      {onComputer.has(f.path) && <OnComputerBadge />}
                    </div>
                  </div>

                  {/* Ouvrir (voir) + Référence + emplacement RÉSERVÉ pour la poubelle → aucun décalage.
                      Sur mobile, le bloc passe sous le titre au lieu de l'écraser. */}
                  <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto">
                    {href && <SeeLink href={href} label={f.title} />}
                    <button
                      type="button"
                      ref={triggerRef(f.path)}
                      onClick={() => openForm({ path: f.path, title: f.title, kind: f.kind === "midterm" ? "midterm" : "final", year: f.year, edit: true })}
                      disabled={isBusy || reindexing}
                      aria-label={t("editExamLabelFor", { title: f.title })}
                      aria-expanded={classifying?.path === f.path}
                      className={ACTION_BTN}
                    >
                      {t("editExamLabel")}
                    </button>
                    <button
                      type="button"
                      onClick={() => classify(f.path, f.title, { as: "support" })}
                      disabled={isBusy || reindexing}
                      aria-label={t("classifyAsSupportFor", { title: f.title })}
                      className={ACTION_BTN}
                    >
                      {t("classifyAsSupport")}
                    </button>
                    <RefCheckbox checked={isRef(f)} busy={isBusy} onToggle={() => toggleRef(f)} label={f.title} />
                    {f.uploaded ? (
                      <button
                        type="button"
                        onClick={() => remove(f)}
                        disabled={isBusy}
                        aria-label={t("remove", { title: f.title })}
                        className="grid size-11 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-danger-hi focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:opacity-40"
                      >
                        <Trash2 className="size-4" strokeWidth={2} />
                      </button>
                    ) : (
                      <span className="size-11 shrink-0" aria-hidden="true" />
                    )}
                  </div>
                  {formFor(f.path, f.title)}
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-[0.78rem] text-ink-3">
            {t("referenceCount", { count: refCount })}
          </div>
        </>
      ) : (
        // Vue « browse » d'un type de corpus : chaque item ouvrable via « Voir ».
        <div className="divide-y divide-line px-1.5">
          {browseRows.length === 0 ? (
            <p className="px-4 py-8 text-center text-[0.85rem] text-ink-3">{t("empty")}</p>
          ) : (
            browseRows.map((s) => {
              const ext = extOf(s.path);
              const Icon = ext === "HTML" || ext === "HTM" ? FileCode2 : FileText;
              const isBusy = busy.has(s.path);
              return (
                <div key={s.path} className="flex flex-wrap items-center gap-3 px-4 py-4 transition-colors hover:bg-surface-2/40">
                  <span className="grid size-8 shrink-0 place-items-center rounded-md border border-line bg-surface-2/60 text-ink-3">
                    <Icon className="size-4" strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[0.88rem] text-ink-1" title={s.title}>
                      {s.title}
                      {s.year ? <span className="ml-1.5 text-ink-3">· {s.year}</span> : null}
                    </div>
                    <div className="text-[0.72rem] text-ink-4">
                      <span className="font-data">{ext}</span>
                      {onComputer.has(s.path) && <OnComputerBadge />}
                    </div>
                  </div>
                  <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 sm:w-auto">
                    {s.href && <SeeLink href={s.href} label={s.title} />}
                    <button
                      type="button"
                      ref={triggerRef(s.path)}
                      onClick={() => openForm({ path: s.path, title: s.title, ...guessExam(s.title), edit: false })}
                      disabled={isBusy || reindexing}
                      aria-label={t("classifyAsExamFor", { title: s.title })}
                      aria-expanded={classifying?.path === s.path}
                      className={ACTION_BTN}
                    >
                      {t("classifyAsExam")}
                    </button>
                  </div>
                  {formFor(s.path, s.title)}
                </div>
              );
            })
          )}
        </div>
      )}
    </Panel>
  );
}

/** Lien « voir » : ouvre la source (cours / série / exercice / annale) à sa page. */
function SeeLink({ href, label }: { href: string; label: string }) {
  const t = useTranslations("fileManager");
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t("viewNewTab", { title: label })}
      className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md border border-line bg-surface-2/40 px-2.5 text-[0.78rem] font-medium text-ink-2 transition-colors hover:border-[color-mix(in_oklch,var(--color-accent)_40%,transparent)] hover:text-accent-hi focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
    >
      {t("view")}
      <ArrowUpRight className="size-3.5" strokeWidth={2.25} />
    </a>
  );
}

/** Case à cocher accessible « annale de référence ». */
function RefCheckbox({ checked, busy, onToggle, label }: { checked: boolean; busy: boolean; onToggle: () => void; label: string }) {
  const t = useTranslations("fileManager");
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={t("useAsReference", { title: label })}
      disabled={busy}
      onClick={onToggle}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-md border px-2.5 text-[0.78rem] font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:opacity-50",
        checked
          ? "border-[color-mix(in_oklch,var(--color-accent)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-accent)_16%,transparent)] text-accent-hi"
          : "border-line bg-surface-2/40 text-ink-3 hover:text-ink-1"
      )}
    >
      <span
        aria-hidden="true"
        className={cn("grid size-4 place-items-center rounded-[5px] border transition-colors", checked ? "border-transparent bg-accent-deep text-white" : "border-line-strong bg-surface-1")}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
      {t("reference")}
    </button>
  );
}

/**
 * Type d'épreuve et année d'une annale, en ligne sous le fichier. Le focus entre sur le type
 * choisi à l'ouverture ; Échap ou « Annuler » ferme et rend le focus au bouton d'origine.
 */
function ClassifyForm({ initial, busy, onCancel, onSubmit }: {
  initial: Classifying;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (kind: ExamKind, year: number | null) => void;
}) {
  const t = useTranslations("fileManager");
  const id = useId();
  const [kind, setKind] = useState<ExamKind>(initial.kind);
  const [year, setYear] = useState(initial.year != null ? String(initial.year) : "");
  const first = useRef<HTMLInputElement>(null);
  const maxYear = new Date().getFullYear() + 1;

  useEffect(() => { first.current?.focus(); }, []);

  return (
    <form
      className="flex w-full flex-wrap items-end gap-3 rounded-md border border-line bg-surface-2/40 px-3 py-3"
      aria-label={t(initial.edit ? "editExamLabelFor" : "classifyAsExamFor", { title: initial.title })}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(kind, year.trim() ? Number(year) : null);
      }}
    >
      <fieldset className="flex items-center gap-1.5">
        <legend className="mb-1 text-[0.72rem] text-ink-3">{t("examKind")}</legend>
        {(["final", "midterm"] as const).map((k) => (
          <label
            key={k}
            className={cn(
              "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-[0.8rem] font-medium",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent has-[:focus-visible]:outline-offset-2",
              kind === k ? "border-accent text-accent-hi" : "border-line text-ink-2",
            )}
          >
            <input
              ref={kind === k ? first : undefined}
              type="radio"
              name={`${id}-kind`}
              value={k}
              checked={kind === k}
              onChange={() => setKind(k)}
              className="size-4 accent-[var(--color-accent)]"
            />
            {t(k === "final" ? "kindFinal" : "kindMidterm")}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col">
        <label htmlFor={`${id}-year`} className="mb-1 text-[0.72rem] text-ink-3">
          {t("examYear")} <span className="text-ink-4">({t("examYearHint")})</span>
        </label>
        <input
          id={`${id}-year`}
          type="number"
          inputMode="numeric"
          min={1950}
          max={maxYear}
          step={1}
          value={year}
          onChange={(e) => setYear(e.target.value)}
          className="min-h-11 w-28 rounded-lg border border-line-strong bg-surface-2/40 px-3 font-data text-[0.85rem] text-ink-1 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        />
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          {t(initial.edit ? "saveLabel" : "classifyAsExam")}
        </Button>
      </div>
    </form>
  );
}
