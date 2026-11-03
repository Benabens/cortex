"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { FileText, BookOpen } from "lucide-react";
import { DeepLink } from "./DeepLink";
import { trainHref } from "@/lib/ux/next-up";
import { toStatus } from "@/lib/ux/types";
import type { PlanChapterUi, ProgramTopic } from "@/lib/ux/program";

const labels = { JAMAIS_VU: "Jamais vu", EN_COURS: "En cours", SOLIDE: "Solide" };
const fills = {
  JAMAIS_VU: "border-line-strong bg-surface-2",
  EN_COURS: "border-violet bg-violet/25",
  SOLIDE: "border-violet bg-violet text-blue-950",
};

export function ProgramMap({ chapters, topics }: { chapters: PlanChapterUi[]; topics: ProgramTopic[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const detail = useRef<HTMLElement>(null);
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const notion = chapters.flatMap((chapter) => chapter.notions).find((item) => item.key === selected);
  const statusOf = (id: number) => {
    const topic = byId.get(id);
    return toStatus(topic?.status ?? "never", topic?.mastery ?? null);
  };

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,.47fr)]">
      <section className="d2-card p-4 sm:p-5" aria-label="Carte des notions">
        <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink-2">
          {Object.entries(labels).map(([status, label]) => <li key={status} className="flex items-center gap-2">
            <span className={`size-3 rounded border ${fills[status as keyof typeof fills]}`} aria-hidden="true" />{label}
          </li>)}
        </ul>
        {chapters.map((chapter) => (
          <div key={chapter.id ?? chapter.title} className="border-t border-line py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-sm font-semibold">{chapter.lectureNo != null && `L${chapter.lectureNo} · `}{chapter.title}</h2>
              {chapter.sourceHref && <DeepLink href={chapter.sourceHref} Icon={BookOpen}>Support</DeepLink>}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {chapter.notions.map((item) => {
                const status = statusOf(item.key);
                return <button key={item.key} type="button" aria-pressed={selected === item.key}
                  aria-label={`${item.title} · ${labels[status]}`}
                  onClick={() => {
                    setSelected(item.key);
                    if (!window.matchMedia("(min-width: 1024px)").matches) detail.current?.scrollIntoView({ block: "nearest" });
                  }}
                  className={`min-h-11 min-w-11 max-w-full break-words rounded-lg border px-2 text-left text-xs font-medium hover:brightness-125 aria-pressed:outline-2 aria-pressed:outline-offset-2 aria-pressed:outline-violet-hi ${fills[status]}`}>
                  {item.title}
                </button>;
              })}
              {!chapter.notions.length && <p className="text-xs text-ink-3">Aucune notion rattachée</p>}
            </div>
          </div>
        ))}
      </section>
      <section ref={detail} className="d2-card scroll-mt-20 p-5 lg:sticky lg:top-20" aria-label="Détail de la notion">
        {notion ? (
          <>
            <p className="text-xs text-violet-hi">{labels[statusOf(notion.key)]}</p>
            <h2 className="mt-2 break-words text-xl font-semibold">{notion.title}</h2>
            {notion.desc && <p className="mt-2 text-sm text-ink-2">{notion.desc}</p>}
            <p className="mt-3 text-sm text-ink-3">{notion.count ? `Tombé ${notion.count} fois aux finals` : "Au programme"}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {notion.occurrences.map((o) => o.examHref
                ? <DeepLink key={o.key} href={o.examHref} Icon={FileText}>{o.label}</DeepLink>
                : <span key={o.key} className="text-xs text-ink-3">{o.label}</span>)}
              {notion.courseHref && <DeepLink href={notion.courseHref} Icon={BookOpen}>Passage de cours</DeepLink>}
            </div>
            <Link href={`/seance?notion=${notion.key}`} className="mt-4 flex min-h-11 items-center text-sm font-medium text-violet-hi">Ajouter à ma séance →</Link>
            <Link href={trainHref(notion.title)} className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-violet-hi">Travailler cette notion →</Link>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold">Détail de la notion</h2>
            <p className="mt-2 text-sm text-ink-3">Choisis une notion pour retrouver ses occurrences aux finals et son support.</p>
          </>
        )}
      </section>
    </div>
  );
}
