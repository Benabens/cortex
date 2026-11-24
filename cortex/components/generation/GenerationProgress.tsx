"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import { Orb } from "./Orb";
import { useCourse, withCourse, JOB_ACTIVE, type Job } from "@/lib/ux/api";
import { useShowJob } from "./useShowJob";
import { barValue, cancelOutcome, elapsedMinutes, orbStateFor, rangeText, stageOf } from "@/lib/ux/generation";
import { cn } from "@/lib/ux/cn";

/**
 * Ce que l'étudiant peut faire en attendant un examen (3 à 7 min) : le compositeur seul les
 * propose. Ailleurs l'attente est courte, ou la page est déjà le point de départ (Accueil).
 */
const MEANWHILE: Record<string, { key: "weak" | "train"; href: string }[]> = {
  exam: [{ key: "weak", href: "/faiblesses" }, { key: "train", href: "/entrainement" }],
  qcm: [{ key: "weak", href: "/faiblesses" }, { key: "train", href: "/entrainement" }],
};

/**
 * LE SUIVI D'UNE GÉNÉRATION, UN SEUL COMPOSANT PARTOUT (examens, préparation, exercices,
 * Accueil) — audit generation-ux du 24/11/2026. À tout instant l'étudiant sait :
 *  - que ça avance : l'orbe, qui dit ce que fait le moteur ;
 *  - où on en est : l'étape lisible (lib/job-stage) et la barre, branchée sur l'avancement réel
 *    du worker, qui ne recule jamais ;
 *  - combien il reste : une fourchette lue sur les durées mesurées (lib/eta), « plus long que
 *    d'habitude » sinon, jamais un compte à rebours inventé ;
 *  - quoi faire : changer de page (la génération continue, la pastille le ramène), ou une
 *    suggestion ; annuler, en sachant ce qui est gardé.
 * `job` null : la génération est en train d'être lancée.
 */
export function GenerationProgress({ job, cancelable = true, meanwhile = true, announceDone = false, onCanceled, className }: {
  job: Job | null;
  cancelable?: boolean;
  meanwhile?: boolean;
  /** La page s'efface au succès sans rien dire : la notification de fin l'annonce (useShowJob). */
  announceDone?: boolean;
  onCanceled?: () => void;
  className?: string;
}) {
  const t = useTranslations("generation");
  const { courseId } = useCourse();
  // La barre ne recule jamais (le worker peut republier un avancement plus bas en reprenant une étape).
  const [bar, setBar] = useState<{ id: number; value: number } | null>(null);
  const value = job ? barValue(bar, job) : 0;
  if (job && (bar?.id !== job.id || bar.value !== value)) setBar({ id: job.id, value });
  // Cette page montre le suivi : la pastille ne le répète pas, la fin n'est pas notifiée en double.
  useShowJob(job?.id, !!job && JOB_ACTIVE.includes(job.status), announceDone);

  // Le temps écoulé se met à jour seul (la page peut rester ouverte sans nouvel état du job).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const queued = job?.status === "queued";
  const stage = stageOf(job);
  const step = !job ? t("launching") : job.currentStep || (queued ? t("queued") : t("running"));
  const range = job?.etaLate ? null : rangeText(job?.etaRange?.lowMs, job?.etaRange?.highMs);
  const eta = !job ? null
    : job.etaLate ? t("etaLate")
    : !range ? null
    : queued
      ? range.kind === "range" ? t("etaQueuedRange", range) : t("etaQueuedAbout", { minutes: range.kind === "about" ? range.minutes : 1 })
      : range.kind === "under" ? t("etaUnder") : range.kind === "about" ? t("etaAbout", range) : t("etaRange", range);
  const elapsed = elapsedMinutes(job?.createdAt, now);

  // Annonce aux lecteurs d'écran : au changement d'étape seulement, pas à chaque point de la barre.
  const announce = !job ? t("launching") : queued ? t("queued") : stage ? t(`phase.${stage.stage}`) : t("running");

  const links = meanwhile && job ? MEANWHILE[job.type] ?? [] : [];
  return (
    <section
      aria-label={t("label")}
      data-stage={stage?.stage}
      className={cn("rounded-xl border border-line bg-surface-2/40 px-4 py-4 sm:px-5", className)}
    >
      <div className="flex items-start gap-3.5">
        <Orb state={orbStateFor(job)} size={32} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="min-w-0 text-[0.92rem] font-medium text-ink-1 [overflow-wrap:anywhere]">{step}</p>
            {eta && <p className="font-data text-[0.8rem] tabular-nums text-ink-2">{eta}</p>}
          </div>
          <div
            role="progressbar"
            aria-label={t("progress")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={job ? value : undefined}
            aria-valuetext={job ? t("progressText", { value, step: announce }) : t("launching")}
            className="gen-track mt-2.5"
          >
            <div className="gen-fill" data-indeterminate={!job || undefined} style={{ transform: `scaleX(${value / 100})` }} />
          </div>
          <p className="mt-2 text-[0.78rem] leading-relaxed text-ink-3">
            {elapsed !== null && <span className="font-data tabular-nums">{t("elapsed", { minutes: elapsed })}</span>}
            {elapsed !== null && " · "}
            {t("leaveHint")}
          </p>
        </div>
      </div>
      {(links.length > 0 || (cancelable && job)) && (
        <div className="mt-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-2 border-t border-line pt-3">
          {links.length > 0 && <span className="text-[0.78rem] text-ink-3">{t("meanwhile")}</span>}
          {links.map((l) => (
            <Link key={l.key} href={withCourse(l.href, courseId)} className="gen-chip">
              {t(`meanwhileLink.${l.key}`)}
            </Link>
          ))}
          {cancelable && job && <CancelButton job={job} courseId={courseId} onCanceled={onCanceled} />}
        </div>
      )}
      <p className="sr-only" aria-live="polite">{announce}</p>
    </section>
  );
}

/** Annuler en deux temps : la seconde étape dit ce que l'annulation garde ou rend (lib/jobs cancelJob). */
function CancelButton({ job, courseId, onCanceled }: { job: Job; courseId: string; onCanceled?: () => void }) {
  const t = useTranslations("generation");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const outcomeId = useId();
  // Le focus suit le bouton affiché : vers « Arrêter » à l'ouverture, retour sur « Annuler » si on garde.
  const opened = useRef(false);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (opened.current) cancelRef.current?.focus();
    opened.current = confirming;
  }, [confirming]);

  const cancel = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(withCourse(`/api/jobs/${job.id}/cancel`, courseId), { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      setConfirming(false);
      onCanceled?.();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <button ref={cancelRef} type="button" className="gen-cancel ml-auto" onClick={() => setConfirming(true)}>
        {t("cancel")}
      </button>
    );
  }
  return (
    <div
      role="group"
      aria-label={t("cancel")}
      className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 sm:ml-auto sm:w-auto"
      onKeyDown={(e) => { if (e.key === "Escape" && !busy) setConfirming(false); }}
    >
      <p id={outcomeId} className="text-[0.78rem] text-ink-2" aria-live="polite">{failed ? t("cancelFailed") : t(`cancelOutcome.${cancelOutcome(job)}`)}</p>
      <div className="flex items-center gap-2">
        <button type="button" className="gen-cancel" onClick={() => setConfirming(false)} disabled={busy}>{t("cancelKeep")}</button>
        <button ref={confirmRef} type="button" className="gen-cancel gen-cancel-confirm" onClick={cancel} disabled={busy} aria-describedby={outcomeId}>
          {busy ? t("canceling") : t("cancelConfirm")}
        </button>
      </div>
    </div>
  );
}

/**
 * ATTENTE COURTE SANS ÉTAPES (exercice d'entraînement, correction d'une réponse) : un seul appel
 * au modèle, rien à compter. On dit ce qui se passe, la durée habituelle, et le temps écoulé,
 * sans barre inventée.
 */
export function GenerationWait({ kind, startedAt, className }: { kind: "drill" | "check"; startedAt: number; className?: string }) {
  const t = useTranslations("generation");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return (
    <div className={cn("flex items-center gap-3", className)} role="status">
      <Orb state={kind === "check" ? "solving" : "composing"} size={32} />
      <div className="min-w-0">
        <p className="text-[0.9rem] font-medium text-ink-1">{t(`wait.${kind}`)}</p>
        <p className="text-[0.78rem] text-ink-3">
          {t(`waitTypical.${kind}`)} · <span className="font-data tabular-nums" aria-hidden="true">{clock}</span>
        </p>
      </div>
    </div>
  );
}
