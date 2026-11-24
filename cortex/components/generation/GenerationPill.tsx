"use client";

import Link from "next/link";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
import { Check, AlertTriangle, X } from "lucide-react";
import { Orb } from "./Orb";
import { dismissToast, jobKey, subscribeTracker, trackerState, type GenerationToast } from "@/lib/ux/generation-tracker";
import { orbStateFor, pageOfJob } from "@/lib/ux/generation";
import { useCourse } from "@/lib/ux/api";

const SERVER_STATE = { jobs: [], toasts: [], shown: new Set<string>() };
const useTracker = () => useSyncExternalStore(subscribeTracker, trackerState, () => SERVER_STATE);

/**
 * PASTILLE — une génération tourne ailleurs que sur la page affichée (autre page, autre cours) :
 * son étape et son avancement, un clic pour revenir à son suivi. Masquée quand la page montre
 * déjà ce job. Dans la barre du haut dès 640 px ; en dessous la barre est pleine (à 320 px le
 * menu sortait de l'écran), elle se pose en bas, à portée du pouce, avec les notifications.
 * Job d'un autre cours que celui affiché : son code d'abord, sinon on croit suivre le cours ouvert.
 */
export function GenerationPill({ placement }: { placement: "topbar" | "dock" }) {
  const t = useTranslations("generation");
  const { jobs, shown } = useTracker();
  const { courseId, courses } = useCourse();
  const visible = jobs.filter((j) => !shown.has(jobKey(j.course, j.id)));
  if (!visible.length) return null;
  const job = visible[0];
  const href = pageOfJob(job.type, job.course) ?? "/";
  const step = job.currentStep ?? t(job.status === "queued" ? "queued" : "running");
  const pct = job.status === "queued" ? null : `${Math.round(job.progress)} %`;
  // Le nom accessible reprend le texte visible (étape, pourcentage), puis le cours et l'action.
  const name = t("pill.open", { step: pct ? `${step} ${pct}` : step, course: job.courseLabel });
  const dock = placement === "dock";
  const other = job.course !== courseId ? courses.find((c) => c.id === job.course) : undefined;
  const tag = other ? other.code || other.short : null;
  return (
    <Link
      href={href}
      className={dock
        ? "gen-pill pointer-events-auto flex h-11 min-w-0 items-center gap-2.5 self-center rounded-full border border-line-strong bg-surface-1 pl-2 pr-4 text-[0.8rem] shadow-[var(--shadow-card)] sm:hidden"
        : "gen-pill hidden h-10 max-w-[19rem] shrink-0 items-center gap-2 rounded-full border border-line bg-surface-2/60 pl-1.5 pr-3 text-[0.78rem] hover:border-line-strong hover:bg-surface-2 sm:inline-flex"}
      aria-label={name}
    >
      <Orb state={orbStateFor(job)} size={20} className="rounded-full" />
      {tag && <span className="shrink-0 whitespace-nowrap font-data text-ink-3">{tag}</span>}
      <span className={dock ? "min-w-0 truncate text-ink-2" : "hidden min-w-0 truncate text-ink-2 md:inline"}>{step}</span>
      {pct && <span className="whitespace-nowrap font-data font-semibold tabular-nums text-ink-1">{pct}</span>}
      {visible.length > 1 && <span className="font-data text-ink-3">{t("pill.more", { count: visible.length - 1 })}</span>}
    </Link>
  );
}

/**
 * NOTIFICATIONS DE FIN — une génération suivie ailleurs se termine : prête (lien direct) ou en
 * échec (sa cause, et la page d'où la relancer). Une réussite s'efface seule après 15 s, sauf
 * survolée ou focalisée ; un échec reste jusqu'à ce qu'on le ferme.
 */
export function GenerationToasts() {
  const t = useTranslations("generation");
  const { toasts } = useTracker();
  // Fin arrivée onglet caché : le titre de l'onglet le dit, jusqu'au retour sur l'onglet.
  const count = toasts.length;
  useEffect(() => {
    if (!count || document.visibilityState !== "hidden") return;
    const base = document.title;
    document.title = `${t("toast.tabTitle", { count })} · ${base}`;
    const restore = () => { if (document.visibilityState === "visible") document.title = base; };
    document.addEventListener("visibilitychange", restore);
    return () => {
      document.removeEventListener("visibilitychange", restore);
      document.title = base;
    };
  }, [count, t]);
  return (
    <div
      role="region"
      aria-label={t("toast.region")}
      className="pointer-events-none fixed inset-x-4 bottom-4 z-40 flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[22rem]"
    >
      {/* Seules les notifications sont annoncées : la pastille, qui change à chaque tour, reste hors de la zone. */}
      <div aria-live="polite" className="flex flex-col gap-2">
        {toasts.map((toast) => <Toast key={toast.key} toast={toast} />)}
      </div>
      <GenerationPill placement="dock" />
    </div>
  );
}

function Toast({ toast }: { toast: GenerationToast }) {
  const t = useTranslations("generation");
  const ref = useRef<HTMLDivElement>(null);
  // Même lien que le compositeur (examHref) : un examen en ligne porte son cours, un PDF est servi tel quel.
  const href = toast.status === "done" && toast.resultPath?.startsWith("/mock/")
    ? `${toast.resultPath}?course=${encodeURIComponent(toast.course)}`
    : toast.status === "done" && toast.resultPath?.startsWith("/") ? toast.resultPath
    : pageOfJob(toast.type, toast.course);
  useEffect(() => {
    if (toast.status !== "done") return;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => dismissToast(toast.key), 15_000);
    const el = ref.current;
    const hold = () => { if (timer) clearTimeout(timer); timer = null; };
    el?.addEventListener("pointerenter", hold);
    el?.addEventListener("focusin", hold);
    return () => {
      if (timer) clearTimeout(timer);
      el?.removeEventListener("pointerenter", hold);
      el?.removeEventListener("focusin", hold);
    };
  }, [toast.key, toast.status]);
  const done = toast.status === "done";
  return (
    <div ref={ref} className="gen-toast pointer-events-auto flex items-start gap-3 rounded-xl border border-line-strong bg-surface-1 px-4 py-3 shadow-[var(--shadow-card)]">
      {done
        ? <Check className="mt-0.5 size-4 shrink-0 text-accent-hi" strokeWidth={2.5} aria-hidden="true" />
        : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger-hi" strokeWidth={2} aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <p className="text-[0.86rem] font-medium text-ink-1">{t(done ? "toast.done" : "toast.failed", { type: toast.type })}</p>
        <p className="truncate text-[0.76rem] text-ink-3">{toast.courseLabel}</p>
        {!done && toast.error && <p className="mt-1 line-clamp-3 text-[0.78rem] leading-snug text-ink-2">{toast.error}</p>}
        {href && (
          <Link href={href} onClick={() => dismissToast(toast.key)} className="mt-1.5 inline-block text-[0.8rem] font-medium text-ink-1 underline underline-offset-2">
            {done ? t("toast.open") : t("toast.see")}
          </Link>
        )}
      </div>
      <button type="button" onClick={() => dismissToast(toast.key)} aria-label={t("toast.close")} className="gen-cancel -mr-1.5 -mt-1 grid size-8 place-items-center p-0">
        <X className="size-4" strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
