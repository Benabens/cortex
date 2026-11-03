"use client";

import { PageHeader } from "@/components/ui/PageHeader";
import { WeaknessInbox } from "@/components/faiblesses/WeaknessInbox";
import { WeaknessBase } from "@/components/faiblesses/WeaknessBase";
import { LoadError } from "@/components/ui/LoadError";
import { useApi, useCourse } from "@/lib/ux/api";
import type { WeaknessesResp } from "@/lib/ux/weaknesses";

export default function FaiblessesPage() {
  const { courseId } = useCourse();
  const { data, loading, error, refetch } = useApi<WeaknessesResp>("/api/weaknesses");
  const weaknesses = data?.weaknesses ?? [];
  const severe = weaknesses.filter((weakness) => weakness.severity >= 3).length;
  const pending = weaknesses.filter((weakness) => !weakness.analyzed).length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Faiblesses"
        description="Retrouve ce qui te bloque, ajoute un exercice raté et repars avec un entraînement ciblé."
      />
      {data && (
        <section aria-label="Résumé des faiblesses" className="grid grid-cols-3 gap-3">
          {[
            { value: weaknesses.length, label: "Faiblesses suivies" },
            { value: severe, label: "À traiter en priorité" },
            { value: pending, label: "À analyser" },
          ].map(({ value, label }) => (
            <div key={label} className="d2-card p-4 sm:p-5">
              <p className="font-display text-3xl font-semibold tabular-nums">{value}</p>
              <p className="mt-2 text-xs leading-relaxed text-ink-3 sm:text-sm">{label}</p>
            </div>
          ))}
        </section>
      )}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,.55fr)]">
        <div className="min-w-0" id="faiblesses">
          {loading ? (
            <div className="skeleton h-80 rounded-xl" aria-busy="true" aria-label="Chargement des faiblesses" />
          ) : error || !data ? (
            <LoadError title="Impossible de charger tes faiblesses" hint="Réessaie, ou choisis un autre cours." onRetry={refetch} />
          ) : (
            <WeaknessBase key={courseId} weaknesses={weaknesses} onChanged={refetch} />
          )}
        </div>
        <WeaknessInbox key={courseId} onAdded={refetch} />
      </div>
    </div>
  );
}
