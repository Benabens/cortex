"use client";

import { WifiOff, RotateCw } from "lucide-react";
import { useApi, asText } from "@/lib/ux/api";
import type { Dash } from "@/lib/ux/types";
import { Greeting } from "@/components/dashboard/Greeting";
import { NextExerciseHero } from "@/components/dashboard/NextExerciseHero";
import { OnboardingHero } from "@/components/dashboard/OnboardingHero";
import { MetricsCluster } from "@/components/dashboard/MetricsCluster";
import { WeaknessesPreview } from "@/components/dashboard/WeaknessesPreview";
import { RecentActivity } from "@/components/dashboard/RecentActivity";
import { QuickActions } from "@/components/dashboard/QuickActions";
import { JobBanner } from "@/components/dashboard/JobBanner";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/primitives";

export default function DashboardPage() {
  const { data, loading, error, refetch } = useApi<Dash>("/api/dashboard");

  if (loading) return <DashboardSkeleton />;

  if (error || !data) {
    return (
      <Panel className="mx-auto mt-10 flex max-w-md flex-col items-center gap-4 p-8 text-center">
        <span className="grid size-12 place-items-center rounded-full border border-line bg-surface-2/60 text-danger-hi">
          <WifiOff className="size-5" strokeWidth={2} aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-[1.15rem] font-semibold">Impossible de charger ton tableau de bord</h1>
          <p className="mt-1.5 text-[0.88rem] leading-relaxed text-ink-3">
            Le moteur ne répond pas. Vérifie que l’app tourne, puis réessaie.
          </p>
        </div>
        <Button variant="secondary" onClick={refetch}>
          <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
          Réessayer
        </Button>
      </Panel>
    );
  }

  const nextLabel = data.next ? asText(data.next.label) : null;
  // Onboarding : rien d'actionnable (cours pas analysé, ou données inutilisables — cf. MAPPING cs-202).
  const onboarding = !data.analyzed || !nextLabel;

  return (
    <div className="flex flex-col gap-6">
      <Greeting
        course={data.course}
        coveragePct={data.stats.coveragePct}
        analyzed={!onboarding}
      />

      {data.job && (
        <JobBanner
          key={`${data.course.id}-${data.job.id}`}
          initial={data.job}
          onDone={refetch}
        />
      )}

      {onboarding ? (
        <OnboardingHero courseName={data.course.name} />
      ) : (
        <>
          <NextExerciseHero
            title={nextLabel!}
            theme={asText(data.next!.category)}
            weightPct={data.next!.examWeight}
            status={data.next!.status}
            mastery={data.next!.mastery}
          />
          <MetricsCluster
            stats={data.stats}
            schedule={data.schedule}
            weaknessCount={data.weaknesses.count}
            topWeaknesses={data.weaknesses.top}
          />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="flex flex-col gap-4 lg:col-span-2">
              <WeaknessesPreview items={data.weaknesses.top} total={data.weaknesses.count} />
              <RecentActivity exams={data.exams} />
            </div>
            <div className="lg:col-span-1">
              <QuickActions />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Squelette structurel : la page garde sa forme pendant le chargement. */
function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Chargement du tableau de bord">
      <div>
        <div className="skeleton h-3.5 w-56" />
        <div className="skeleton mt-3 h-9 w-72" />
        <div className="skeleton mt-3 h-4 w-96 max-w-full" />
      </div>
      <div className="skeleton h-64 rounded-xl" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-64 rounded-lg" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="skeleton h-64 rounded-lg lg:col-span-2" />
        <div className="skeleton h-64 rounded-lg" />
      </div>
    </div>
  );
}
