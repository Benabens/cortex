"use client";

import { WifiOff, RotateCw } from "lucide-react";
import { useApi, asText } from "@/lib/ux/api";
import type { Dash } from "@/lib/ux/types";
import { Greeting } from "@/components/dashboard/Greeting";
import { PriorityHero } from "@/components/dashboard/PriorityHero";
import { OnboardingHero } from "@/components/dashboard/OnboardingHero";
import { QuietDoors } from "@/components/dashboard/QuietDoors";
import { JobBanner } from "@/components/dashboard/JobBanner";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/primitives";

/**
 * ACCUEIL — l'écran répond à UNE question : « par où je commence maintenant ? »
 *
 * Une colonne courte, une intention : salutation → LE héro (ta priorité du jour) → au plus
 * deux portes en texte. Tout le reste (maîtrise pondérée, programme couvert, courbe de l'oubli,
 * faiblesses, examens récents, actions rapides) vit sur les pages dédiées : le dupliquer ici
 * transformait l'accueil en bulletin de notes.
 */
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

  const nextLabel = data.next ? asText(data.next.label) : null;
  // Onboarding : rien d'actionnable (cours pas analysé, ou données inutilisables — cf. MAPPING cs-202).
  const onboarding = !data.analyzed || !nextLabel;

  return (
    <div className="w-full max-w-[46rem]">
      <Greeting course={data.course} countdown={data.countdown} />

      {data.job && (
        <div className="mt-6">
          <JobBanner
            key={`${data.course.id}-${data.job.id}`}
            initial={data.job}
            onDone={refetch}
          />
        </div>
      )}

      <div className="mt-6">
        {onboarding ? (
          <OnboardingHero courseName={data.course.name} />
        ) : (
          <PriorityHero
            title={nextLabel!}
            theme={asText(data.next!.category)}
            weightPct={data.next!.examWeight}
            mastery={data.next!.mastery}
          />
        )}
      </div>

      {!onboarding && (
        <div className="mt-5">
          <QuietDoors weaknessCount={data.weaknesses.count} reviewsDue={data.schedule.due} />
        </div>
      )}
    </div>
  );
}

/** Squelette structurel : la page garde sa forme (et sa colonne) pendant le chargement. */
function DashboardSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-[46rem]"
      aria-busy="true"
      aria-label="Chargement de ta priorité du jour"
    >
      <div className="skeleton h-3.5 w-56" />
      <div className="skeleton mt-3 h-9 w-64" />
      <div className="skeleton mt-6 h-72 rounded-xl" />
      <div className="skeleton mt-5 h-4 w-52" />
    </div>
  );
}
