"use client";

import { WifiOff, RotateCw } from "lucide-react";
import { useApi } from "@/lib/ux/api";
import type { Dash } from "@/lib/ux/types";
import { CourseLine } from "@/components/dashboard/CourseLine";
import { PlanOverview } from "@/components/dashboard/PlanOverview";
import { OnboardingHero } from "@/components/dashboard/OnboardingHero";
import { JobBanner } from "@/components/dashboard/JobBanner";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/primitives";

const column = "flex w-full flex-col gap-5";

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

  // Onboarding : rien d'actionnable (cours pas analysé, ou données inutilisables — cf. MAPPING cs-202).
  const onboarding = !data.analyzed || data.stats.total === 0;

  return (
    <div className={column}>
      <header>
        <p className="mb-2 text-sm font-medium text-violet-hi">Aujourd’hui</p>
        <h1 className="mb-3 break-words text-3xl font-semibold tracking-tight sm:text-5xl">
          {data.countdown && data.countdown.days >= 0
            ? data.countdown.days === 0 ? "Final aujourd’hui" : `Final dans ${data.countdown.days} jours`
            : data.course.name}
        </h1>
        <CourseLine courseId={data.course.id} code={data.course.examCode} countdown={data.countdown} />
      </header>

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
        <div className="d2-card max-w-[46rem] p-5 sm:p-7">
          <OnboardingHero courseName={data.course.name} />
        </div>
      ) : (
        <PlanOverview data={data} />
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
