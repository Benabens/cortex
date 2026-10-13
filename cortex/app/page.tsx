"use client";

import { WifiOff, RotateCw } from "lucide-react";
import { useApi, asText } from "@/lib/ux/api";
import type { Dash } from "@/lib/ux/types";
import { CourseLine } from "@/components/dashboard/CourseLine";
import { PriorityHero } from "@/components/dashboard/PriorityHero";
import { UpNext } from "@/components/dashboard/UpNext";
import { OnboardingHero } from "@/components/dashboard/OnboardingHero";
import { QuietDoors } from "@/components/dashboard/QuietDoors";
import { JobBanner } from "@/components/dashboard/JobBanner";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/primitives";

/**
 * ACCUEIL — l'écran répond à UNE question : « par où je commence maintenant ? »
 *
 * « Next up » : la ligne du cours et du final, la notion à travailler en très grand avec sa
 * raison et son bouton, puis « Ensuite » (les trois suivantes) et au plus deux portes en texte.
 * Rien d'autre : ni carte autour du héro, ni métrique. Maîtrise, programme couvert, faiblesses,
 * examens récents vivent sur leurs pages ; les dupliquer ici faisait de l'accueil un bulletin.
 */

/** Colonne de l'Accueil : 884 px au plus, en retrait de la marge de l'app sur grand écran (maquette du labo). */
const column = "w-full max-w-[55.25rem] lg:ml-12 lg:mt-11";

export default function DashboardPage() {
  const { data, loading, error, refetch } = useApi<Dash>("/api/dashboard");

  if (loading) return <DashboardSkeleton />;

  // Même forme d'erreur que les 6 autres écrans (icône nue · 0,95rem · corps 0,85rem · bouton sm).
  if (error || !data) {
    return (
      <Panel className="flex flex-col items-center gap-3 rounded-xl px-6 py-12 text-center">
        <WifiOff className="size-6 text-danger-hi" strokeWidth={2} aria-hidden="true" />
        <p className="text-[0.95rem] font-medium text-ink-1">Impossible de charger ta priorité</p>
        <p className="max-w-xs text-[0.85rem] leading-relaxed text-ink-3">
          Le moteur ne répond pas. Vérifie que l’app tourne, puis réessaie.
        </p>
        <Button variant="secondary" size="sm" onClick={refetch}>
          <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
          Réessayer
        </Button>
      </Panel>
    );
  }

  const next = data.next;
  const nextLabel = next ? asText(next.label) : null;
  // Onboarding : rien d'actionnable (cours pas analysé, ou données inutilisables — cf. MAPPING cs-202).
  const onboarding = !data.analyzed || !next || !nextLabel;

  return (
    <div className={column}>
      <CourseLine courseId={data.course.id} code={data.course.examCode} countdown={data.countdown} />

      {data.job && (
        <div className="mt-5">
          <JobBanner
            key={`${data.course.id}-${data.job.id}`}
            initial={data.job}
            onDone={refetch}
          />
        </div>
      )}

      {onboarding ? (
        <div className="mt-6 max-w-[46rem]">
          <OnboardingHero courseName={data.course.name} />
        </div>
      ) : (
        <>
          <div className="mt-[1.875rem]">
            <PriorityHero
              title={nextLabel}
              facts={{
                count: next.count,
                examWeight: next.examWeight,
                status: next.status,
                mastery: next.mastery,
                chapter: next.chapter ? { lectureNo: next.chapter.lectureNo, title: asText(next.chapter.title) } : null,
              }}
            />
          </div>
          <div className="mt-11">
            <UpNext topics={data.upNext ?? []} />
          </div>
          <div className="mt-2.5">
            <QuietDoors weaknessCount={data.weaknesses.count} reviewsDue={data.schedule.due} />
          </div>
        </>
      )}
    </div>
  );
}

/** Squelette structurel : la page garde sa forme (ligne, titre, phrase, bouton, liste) pendant le chargement. */
function DashboardSkeleton() {
  return (
    <div className={column} aria-busy="true" aria-label="Chargement de ta priorité du jour">
      <div className="skeleton h-3.5 w-56" />
      <div className="skeleton mt-[1.875rem] h-3.5 w-40" />
      <div className="skeleton mt-3 h-11 w-[26rem] max-w-full sm:h-14 lg:h-16" />
      <div className="skeleton mt-4 h-4 w-[34rem] max-w-full" />
      <div className="skeleton mt-2 h-4 w-80 max-w-full" />
      <div className="skeleton mt-6 h-11 w-36 rounded-md" />
      <div className="mt-11 flex flex-col gap-3">
        <div className="skeleton h-3.5 w-16" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-10" />
        ))}
      </div>
    </div>
  );
}
