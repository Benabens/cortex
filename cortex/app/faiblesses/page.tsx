"use client";

import { StudyMilestones } from "@/components/dashboard/StudyMilestones";
import { ExamActivity } from "@/components/dashboard/PlanOverview";
import type { Dash } from "@/lib/ux/types";
import { WifiOff, RotateCw } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { WeaknessInbox } from "@/components/faiblesses/WeaknessInbox";
import { WeaknessBase } from "@/components/faiblesses/WeaknessBase";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { useApi } from "@/lib/ux/api";
import type { WeaknessesResp } from "@/lib/ux/weaknesses";

export default function FaiblessesPage() {
  const { data: dashboard } = useApi<Dash>("/api/dashboard");
  const { data, loading, error, refetch } = useApi<WeaknessesResp>("/api/weaknesses");

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title="Progrès"
        description="Retrouve les notions que tu maîtrises, tes faiblesses et ton activité."
      />

      {dashboard && (
        <section className="d2-hero p-5 sm:p-7">
          <h2 className="text-2xl font-semibold">Maîtrise du programme</h2>
          <p className="mt-3 text-sm text-blue-100">{dashboard.stats.mastered} sur {dashboard.stats.total} notions solides</p>
          <progress className="mt-3 h-2 w-full max-w-lg accent-blue-300" aria-label="Notions solides"
            max={Math.max(1, dashboard.stats.total)} value={dashboard.stats.mastered} />
        </section>
      )}
      <StudyMilestones />
      <h2 id="faiblesses" className="scroll-mt-24 text-2xl font-semibold">Faiblesses</h2>
      <WeaknessInbox onAdded={refetch} />

      {loading ? (
        <div aria-busy="true" aria-label="Chargement des faiblesses">
          <div className="skeleton mb-3 h-9 w-72 rounded-full" />
          <div className="panel space-y-2 rounded-xl p-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 px-2 py-2">
                <div className="skeleton h-5 w-4" />
                <div className="flex-1 space-y-1.5">
                  <div className="skeleton h-4 w-1/2" />
                  <div className="skeleton h-3 w-3/4" />
                </div>
                <div className="skeleton h-10 w-20 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      ) : error || !data ? (
        <Panel className="flex flex-col items-center gap-3 rounded-xl px-6 py-12 text-center">
          <WifiOff className="size-6 text-danger-hi" strokeWidth={2} />
          <p className="text-[0.95rem] font-medium text-ink-1">
            Impossible de charger tes faiblesses
          </p>
          <p className="max-w-xs text-[0.85rem] text-ink-3">
            Le moteur ne répond pas pour ce cours. Réessaie dans un instant.
          </p>
          <Button variant="secondary" size="sm" onClick={refetch}>
            <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
            Réessayer
          </Button>
        </Panel>
      ) : (
        <WeaknessBase weaknesses={data.weaknesses} onChanged={refetch} />
      )}
      {dashboard && <ExamActivity exams={dashboard.exams} />}
    </div>
  );
}
