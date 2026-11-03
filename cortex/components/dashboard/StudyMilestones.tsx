"use client";

import { useState } from "react";
import { Segmented } from "@/components/ui/Segmented";
import Link from "next/link";
import { LoadError } from "@/components/ui/LoadError";
import { useApi } from "@/lib/ux/api";
import { buildTypes, byPriority, type ProgramResp } from "@/lib/ux/program";
import { toStatus } from "@/lib/ux/types";

export function StudyMilestones() {
  const { data, loading, error, refetch } = useApi<ProgramResp>("/api/program");
  const [stage, setStage] = useState<"route" | "essential" | "ready">("route");
  if (loading)
    return (
      <div
        className="skeleton h-48 rounded-xl"
        aria-label="Chargement des paliers"
      />
    );
  if (error)
    return (
      <LoadError title="Impossible de charger les paliers" onRetry={refetch} />
    );
  if (!data) return null;

  const priority = byPriority(buildTypes(data.topics))
    .filter((topic) => topic.count > 0)
    .slice(0, 10);
  if (!priority.length)
    return (
      <section className="d2-card p-6">
        <h2 className="text-xl font-semibold">Tes premiers repères</h2>
        <p className="mt-2 text-sm text-ink-3">
          Les paliers apparaîtront après l’analyse de tes annales.
        </p>
        <Link
          className="mt-3 inline-flex min-h-11 items-center text-sm text-violet-hi"
          href="/sources"
        >
          Ajouter des sources →
        </Link>
      </section>
    );
  const raw = new Map(data.topics.map((topic) => [topic.id, topic]));
  const mastered = priority.filter(({ key }) => {
    const topic = raw.get(key);
    return topic && toStatus(topic.status, topic.mastery) === "SOLIDE";
  }).length;
  const first = Math.min(4, priority.length);
  const target = stage === "route" ? first : priority.length;
  const remaining = Math.max(0, target - mastered);

  return (
    <section className="d2-card p-5 sm:p-6">
      <h2 className="mb-3 text-xl font-semibold">Paliers de révision</h2>
      <Segmented
        label="Palier de révision"
        value={stage}
        onChange={setStage}
        options={[
          { value: "route", label: "En route" },
          { value: "essential", label: "L’essentiel" },
          { value: "ready", label: "À jour" },
        ]}
      />
      <p className="mt-3 text-xs text-ink-3">
        Repères proposés sur les {priority.length} notions les plus fréquentes
        aux finals. Une notion est solide à partir de 7/10.
      </p>
      <p className="mt-3 text-sm text-ink-2">
        {remaining === 0
          ? stage === "ready" && data.stats.due > 0
            ? "Notions consolidées ; des révisions restent à faire."
            : "Palier atteint."
          : `Encore ${remaining} notion${remaining === 1 ? "" : "s"} à consolider.`}{" "}
        {mastered} sur {priority.length} notions prioritaires solides.
      </p>
      {stage === "ready" && (
        <p className="mt-2 text-sm text-ink-3">
          Objectif : consolider toutes les prioritaires et revoir les notions
          dues. {data.stats.due} notion(s) à revoir aujourd’hui.
        </p>
      )}
      <progress
        className="mt-3 h-2 w-full accent-violet"
        max={target}
        value={Math.min(mastered, target)}
        aria-label="Progression vers le palier"
      />
      <ul className="mt-5 grid gap-2 sm:grid-cols-2">
        {priority.map((n) => {
          const t = raw.get(n.key)!;
          const solid = toStatus(t.status, t.mastery) === "SOLIDE";
          return (
            <li key={n.key}>
              <Link
                href={`/programme?notion=${n.key}`}
                className="flex min-h-12 items-center justify-between gap-3 rounded-xl bg-surface-2 p-3 text-sm"
              >
                <span className="min-w-0 break-words">{n.title}</span>
                <span className="shrink-0 text-xs text-violet-hi">
                  {solid
                    ? "Solide"
                    : t.mastery == null
                      ? "À découvrir"
                      : `${t.mastery.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}/10`}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
