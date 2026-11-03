"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { TrainingNav } from "@/components/entrainement/TrainingNav";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { LoadError } from "@/components/ui/LoadError";
import { asText, useApi } from "@/lib/ux/api";
import { trainHref } from "@/lib/ux/next-up";
import type { ProgramResp } from "@/lib/ux/program";
import type { Dash } from "@/lib/ux/types";

export default function SessionPage() {
  return <Suspense fallback={<div className="skeleton h-48 rounded-xl" aria-label="Chargement de la séance" />}><Session /></Suspense>;
}

function Session() {
  const selected = Number(useSearchParams().get("notion"));
  const { data: program } = useApi<ProgramResp>(selected > 0 ? "/api/program" : null);
  const added = program?.topics.find((topic) => topic.id === selected);
  const { data, loading, error, refetch } = useApi<Dash>("/api/dashboard");
  const suggested = data ? [data.next, ...data.upNext].filter((topic) => topic !== null).slice(0, 3) : [];
  const topics = added ? [added, ...suggested.filter((topic) => topic.id !== added.id)] : suggested;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="S’entraîner" description="Choisis ce que tu veux travailler aujourd’hui." />
      <TrainingNav current="/seance" />
      {loading ? <div className="skeleton h-48 rounded-xl" aria-label="Chargement de la séance" /> :
        error || !data ? <LoadError title="Impossible de charger la séance" onRetry={refetch} /> :
        <div className="grid items-start gap-4 lg:grid-cols-[1.6fr_1fr]">
          <Panel className="p-5 sm:p-6">
            <h2 className="text-xl font-semibold">Séance proposée</h2>
            {topics.length ? (
              <ul className="mt-3 divide-y divide-line">
                {topics.map((topic) => {
                  const title = asText(topic.label);
                  if (!title) return null;
                  return <li key={topic.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <span>{title}{added?.id === topic.id && <span className="ml-2 text-xs text-violet-hi">Ajoutée</span>}</span>
                    <Button href={trainHref(title)} variant="secondary" size="sm">Travailler</Button>
                  </li>;
                })}
              </ul>
            ) : <p className="mt-3 text-sm text-ink-3">Les notions suggérées apparaîtront après l’analyse des sources.</p>}
          </Panel>
          <div className="grid gap-4">
            <Link href="/revision" className="d2-card p-5">
              <h2 className="text-xl font-semibold">Révisions</h2>
              <p className="mt-2 text-sm text-ink-2">{data.schedule.due} à revoir · Ouvrir la banque de questions</p>
            </Link>
            <Link href="/faiblesses#faiblesses" className="d2-card p-5">
              <h2 className="text-xl font-semibold">Faiblesses</h2>
              <p className="mt-2 text-sm text-ink-2">{data.weaknesses.count} repérées · Voir mes erreurs</p>
            </Link>
          </div>
        </div>}
    </div>
  );
}
