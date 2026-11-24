"use client";

import { useEffect } from "react";
import { useCourse, jobEnd } from "@/lib/ux/api";
import { showJob } from "@/lib/ux/generation-tracker";
import { lastWatchedJob } from "@/lib/ux/job-watch";

/**
 * Cette page montre le suivi du job `jobId` tant qu'il tourne : la pastille ne le répète pas. À
 * son retrait, la fin n'est pas notifiée si la page l'a vue (le job était fini, sondé par
 * useJob) ; une page quittée pendant la génération laisse la notification de fin arriver.
 * `announceDone` : la page s'efface au succès sans rien dire (bandeau de l'Accueil) — la
 * notification annonce alors la réussite ; un échec reste affiché par la page.
 */
export function useShowJob(jobId: number | null | undefined, active: boolean, announceDone = false): void {
  const { courseId } = useCourse();
  const shownId = active && jobId != null ? jobId : null;
  useEffect(() => {
    if (shownId === null || !courseId) return;
    const unshow = showJob(courseId, shownId);
    return () => {
      const last = lastWatchedJob(shownId, courseId);
      const end = last ? jobEnd(last.status) : null;
      unshow(end !== null && !(announceDone && end === "done"));
    };
  }, [shownId, courseId, announceDone]);
}
