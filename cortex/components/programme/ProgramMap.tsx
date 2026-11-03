"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { FileText, BookOpen } from "lucide-react";
import { DeepLink } from "./DeepLink";
import { asText } from "@/lib/ux/api";
import { trainHref } from "@/lib/ux/next-up";
import { toStatus } from "@/lib/ux/types";
import type { PlanChapterUi, ProgramTopic } from "@/lib/ux/program";

const labels = {
  JAMAIS_VU: "Jamais vu",
  EN_COURS: "En cours",
  SOLIDE: "Solide",
};
const fills = {
  JAMAIS_VU: "border-line-strong bg-surface-2",
  EN_COURS: "border-violet bg-surface-2",
  SOLIDE: "border-violet bg-violet text-blue-950",
};

export function ProgramMap({
  chapters,
  topics,
}: {
  chapters: PlanChapterUi[];
  topics: ProgramTopic[];
}) {
  const params = useSearchParams();
  const router = useRouter();
  const selected = Number(params.get("notion")) || null;
  const filters: Record<string, string> = { prioritaires: "priority", solides: "solid", travailler: "work", finals: "final" };
  const filter = filters[params.get("filtre") ?? ""] ?? "all";
  const setFilter = (value: string) => {
    const url = new URL(window.location.href);
    const key = Object.keys(filters).find((key) => filters[key] === value);
    if (key) url.searchParams.set("filtre", key);
    else url.searchParams.delete("filtre");
    router.replace(url.pathname + url.search, { scroll: false });
  };
  const detail = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected && !window.matchMedia("(min-width: 1024px)").matches)
      detail.current?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
  }, [selected]);
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const notion = chapters
    .flatMap((chapter) => chapter.notions)
    .find((item) => item.key === selected);
  const statusOf = (id: number) => {
    const topic = byId.get(id);
    return toStatus(topic?.status ?? "never", topic?.mastery ?? null);
  };

  const priorityIds = new Set(
    chapters
      .flatMap((c) => c.notions)
      .filter((n) => n.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((n) => n.key),
  );
  const visibleChapters = chapters.map((chapter) => ({
    ...chapter,
    notions: chapter.notions.filter((item) =>
      filter === "all" || (filter === "priority" ? priorityIds.has(item.key)
        : filter === "work" ? statusOf(item.key) !== "SOLIDE"
          : filter === "solid" ? statusOf(item.key) === "SOLIDE" : item.count > 0)),
  })).filter((chapter) => filter === "all" || chapter.notions.length > 0);
  const chosen = selected == null ? null : byId.get(selected);
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,.47fr)]">
      <section className="d2-card p-4 sm:p-5" aria-label="Carte des notions">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">La carte de ton programme</h2>
            <p className="mt-1 text-xs text-ink-3">
              Largeur : fréquence aux finals · remplissage : maîtrise
            </p>
          </div>
          <label className="text-xs text-ink-2">
            Afficher{" "}
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="ml-2 min-h-11 rounded-lg border border-line bg-surface-2 px-2"
            >
              <option value="all">Tout le programme</option>
              <option value="priority">10 prioritaires</option>
              <option value="work">À travailler</option>
              <option value="solid">Solides</option>
              <option value="final">Tombées aux finals</option>
            </select>
          </label>
        </div>
        <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-ink-2">
          {Object.entries(labels).map(([status, label]) => (
            <li key={status} className="flex items-center gap-2">
              <span
                className={`size-3 rounded border ${fills[status as keyof typeof fills]}`}
                aria-hidden="true"
              />
              {label}
            </li>
          ))}
        </ul>
        {visibleChapters.length === 0 && (
          <div className="border-t border-line py-8 text-center">
            <p className="text-sm text-ink-2">Aucune notion ne correspond à ce filtre pour ce cours.</p>
            <button type="button" className="mt-3 min-h-11 rounded-full border border-line px-4 text-sm" onClick={() => setFilter("all")}>Voir tout le programme</button>
          </div>
        )}
        {visibleChapters.map((chapter) => (
          <div
            key={chapter.id ?? chapter.title}
            className="border-t border-line py-3"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-sm font-semibold">
                {chapter.lectureNo != null && `L${chapter.lectureNo} · `}
                {chapter.title}
              </h2>
              {chapter.sourceHref && (
                <DeepLink href={chapter.sourceHref} Icon={BookOpen}>
                  Support
                </DeepLink>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {chapter.notions
                .map((item) => {
                  const status = statusOf(item.key);
                  return (
                    <button
                      key={item.key}
                      type="button"
                      aria-pressed={selected === item.key}
                      aria-label={`${item.title} · ${labels[status]}`}
                      onClick={() => {
                        const url = new URL(window.location.href);
                        url.searchParams.set("notion", String(item.key));
                        router.replace(url.pathname + url.search, {
                          scroll: false,
                        });
                      }}
                      style={{
                        backgroundImage:
                          status === "EN_COURS"
                            ? `linear-gradient(to right, color-mix(in oklch, var(--color-violet) 24%, transparent) ${Math.max(0, Math.min(100, (byId.get(item.key)?.mastery ?? 0) * 10))}%, transparent 0)`
                            : undefined,
                        flexGrow: Math.max(1, item.count),
                        flexBasis: `${Math.max(5, Math.min(18, item.count * 1.4))}rem`,
                      }}
                      className={`relative min-h-14 min-w-11 max-w-full break-words rounded-lg border px-2 text-left text-xs font-medium hover:brightness-125 aria-pressed:outline-2 aria-pressed:outline-offset-2 aria-pressed:outline-violet-hi ${fills[status]}`}
                    >
                      {item.title}
                      <span className="mt-1 block text-[0.65rem] opacity-80">
                        {item.count > 0
                          ? `${item.count} aux finals`
                          : "Au programme"}
                      </span>
                    </button>
                  );
                })}
              {!chapter.notions.length && (
                <p className="text-xs text-ink-3">Aucune notion rattachée</p>
              )}
            </div>
          </div>
        ))}
      </section>
      <section
        ref={detail}
        className="d2-card scroll-mt-20 p-5 lg:sticky lg:top-20"
        aria-label="Détail de la notion"
      >
        {notion ? (
          <>
            <p className="text-xs text-violet-hi">
              {labels[statusOf(notion.key)]}
            </p>
            <h2 className="mt-2 break-words text-xl font-semibold">
              {notion.title}
            </h2>
            {notion.desc && (
              <p className="mt-2 text-sm text-ink-2">{notion.desc}</p>
            )}
            <p className="mt-3 text-sm text-ink-3">
              {chosen?.attempts ?? 0} évaluation(s)
              {chosen?.mastery != null
                ? ` · maîtrise ${chosen.mastery.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}/10`
                : " · pas encore évaluée"}
            </p>
            <p className="mt-3 text-sm text-ink-3">
              {notion.count
                ? `Tombé ${notion.count} fois aux finals`
                : "Au programme"}
            </p>
            <div className="mt-4 space-y-2">
              {chosen?.occurrences_all?.map((o, i) => (
                <details
                  key={`${o.examId}-${i}`}
                  className="rounded-lg border border-line p-3"
                >
                  <summary className="cursor-pointer text-sm">
                    {o.examYear
                      ? `Final ${o.examYear}`
                      : (asText(o.examTitle) ?? "Final")}
                    {o.examPage ? ` · p. ${o.examPage}` : ""}
                    {o.points != null ? ` · ${o.points} pts` : ""}
                  </summary>
                  <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-ink-2">
                    {asText(o.statement) ??
                      "Consulte le final pour retrouver cet exercice."}
                  </p>
                  {o.examHref && (
                    <DeepLink href={o.examHref} Icon={FileText}>
                      Ouvrir le final
                    </DeepLink>
                  )}
                </details>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {notion.occurrences.map((o) =>
                o.examHref ? (
                  <DeepLink key={o.key} href={o.examHref} Icon={FileText}>
                    {o.label}
                  </DeepLink>
                ) : (
                  <span key={o.key} className="text-xs text-ink-3">
                    {o.label}
                  </span>
                ),
              )}
              {notion.courseHref && (
                <DeepLink href={notion.courseHref} Icon={BookOpen}>
                  Passage de cours
                </DeepLink>
              )}
            </div>
            <Link
              href={`/seance?notion=${notion.key}`}
              className="mt-4 flex min-h-11 items-center text-sm font-medium text-violet-hi"
            >
              Ajouter à ma séance →
            </Link>
            <Link
              href={trainHref(notion.title)}
              className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-violet-hi"
            >
              Travailler cette notion →
            </Link>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold">Détail de la notion</h2>
            <p className="mt-2 text-sm text-ink-3">
              Choisis une notion pour retrouver ses occurrences aux finals et
              son support.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
