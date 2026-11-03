"use client";

import { useState } from "react";
import { Segmented } from "@/components/ui/Segmented";
import { useApi } from "@/lib/ux/api";
import { buildTypes, byPriority, type ProgramResp } from "@/lib/ux/program";
import { toStatus } from "@/lib/ux/types";

export function StudyMilestones() {
  const { data } = useApi<ProgramResp>("/api/program");
  const [stage, setStage] = useState<"route" | "essential">("route");
  if (!data) return null;

  const priority = byPriority(buildTypes(data.topics)).filter((topic) => topic.count > 0).slice(0, 10);
  if (!priority.length) return null;
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
      <Segmented label="Palier de révision" value={stage} onChange={setStage}
        options={[{ value: "route", label: "En route" }, { value: "essential", label: "L’essentiel" }]} />
      <p className="mt-3 text-sm text-ink-2">
        {remaining === 0 ? "Palier atteint." : `Encore ${remaining} notion${remaining === 1 ? "" : "s"} à consolider.`}
        {" "}{mastered} sur {priority.length} notions prioritaires solides.
      </p>
      <progress className="mt-3 h-2 w-full accent-violet" max={target} value={Math.min(mastered, target)} aria-label="Progression vers le palier" />
    </section>
  );
}
