"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Layers3,
  Target,
} from "lucide-react";
import { Segmented } from "@/components/ui/Segmented";
import { asText } from "@/lib/ux/api";
import { formatDay, type Dash } from "@/lib/ux/types";
import { trainHref, reason } from "@/lib/ux/next-up";

export function PlanOverview({ data }: { data: Dash }) {
  const [view, setView] = useState<"week" | "final">("week");
  const suggestions = [data.next, ...data.upNext].flatMap((topic) => {
    const title = asText(topic?.label);
    return topic && title ? [{ id: topic.id, title }] : [];
  });
  const topics = suggestions.slice(0, 3);
  const later = suggestions.slice(3);
  const metrics = [
    {
      label: "Notions au programme",
      value: data.stats.total,
      href: "/programme",
      Icon: BookOpen,
    },
    {
      label: "Notions solides",
      value: data.stats.mastered,
      href: "/faiblesses",
      Icon: Layers3,
    },
    {
      label: "Révisions dues",
      value: data.schedule.due,
      href: "/revision",
      Icon: CalendarDays,
    },
    {
      label: "Faiblesses repérées",
      value: data.weaknesses.count,
      href: "/faiblesses#faiblesses",
      Icon: Target,
    },
  ];
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[1.45fr_1fr]">
        <section className="d2-hero flex flex-col items-start p-5 sm:p-7">
          <p className="rounded-full bg-white/13 px-3 py-1 text-sm font-medium text-blue-50">
            Séance proposée
          </p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            Ta séance du jour
          </h2>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-3">
            <span className="font-display text-5xl font-semibold tabular-nums sm:text-6xl">
              {topics.length}
            </span>
            <span className="text-lg font-medium text-blue-50">
              notions à travailler
            </span>
          </div>
          {data.schedule.due > 0 && (
            <p className="mt-1 text-sm text-blue-100">
              {data.schedule.due} révisions dues
            </p>
          )}
          {data.next && (
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-blue-100">
              {(() => {
                const why = reason({ ...data.next!, chapter: null });
                return (
                  <>
                    <span>{asText(data.next?.label)} : </span>
                    {why.lead}
                    <strong>{why.strong}</strong>
                    {why.rest}
                  </>
                );
              })()}
            </p>
          )}
          <ul className="mb-6 mt-4 flex flex-wrap gap-2">
            {topics.map((topic) => (
              <li
                key={topic.id}
                className="break-words rounded-full bg-white/12 px-3 py-1 text-sm"
              >
                {topic.title}
              </li>
            ))}
          </ul>
          <Link
            href="/seance"
            className="mt-auto inline-flex min-h-11 items-center gap-2 rounded-full bg-blue-50 px-4 text-sm font-semibold text-blue-950 hover:bg-white"
          >
            Commencer la séance{" "}
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Link>
        </section>
        <section className="d2-card p-5 sm:p-6">
          <Segmented
            label="Horizon de révision"
            value={view}
            onChange={setView}
            options={[
              { value: "week", label: "Cette semaine" },
              { value: "final", label: "Avant le final" },
            ]}
          />
          {view === "week" ? (
            <>
              <p className="mt-3 text-xs text-ink-3">
                Un rythme proposé, à adapter à tes disponibilités.
              </p>
              <ol className="mt-4 divide-y divide-line">
                <li className="py-3">
                  <Link
                    href="/seance"
                    className="flex items-baseline gap-3 text-sm hover:text-violet-hi"
                  >
                    <span className="min-w-20 text-xs text-violet-hi">
                      Aujourd’hui
                    </span>
                    <span>Ta séance · {topics.length} notions</span>
                  </Link>
                </li>
                {later.map((topic) => (
                  <li key={topic.id} className="py-3">
                    <Link
                      href={trainHref(topic.title)}
                      className="flex items-start gap-3 text-sm hover:text-violet-hi"
                    >
                      <span className="min-w-20 text-xs text-ink-3">
                        Dans 2 jours
                      </span>
                      <span className="min-w-0 break-words">{topic.title}</span>
                    </Link>
                  </li>
                ))}
                <li className="py-3">
                  <Link
                    href="/revision"
                    className="flex items-start gap-3 text-sm hover:text-violet-hi"
                  >
                    <span className="min-w-20 text-xs text-ink-3">
                      Cette semaine
                    </span>
                    <span>Revoir les questions du cours</span>
                  </Link>
                </li>
              </ol>
            </>
          ) : (
            <div className="mt-5">
              <p className="mb-3 text-sm font-medium">
                Consolider le programme, puis se tester
              </p>
              <p className="text-sm text-ink-2">
                {data.stats.mastered} sur {data.stats.total} notions solides
              </p>
              <progress
                className="mt-3 h-2 w-full accent-violet"
                max={Math.max(1, data.stats.total)}
                value={data.stats.mastered}
                aria-label="Notions solides"
              />
              <Link
                href="/programme"
                className="mt-3 inline-flex min-h-11 items-center text-sm text-violet-hi"
              >
                Voir la carte du programme →
              </Link>
            </div>
          )}
        </section>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {metrics.map(({ label, value, href, Icon }) => (
          <Link key={label} href={href} className="d2-card p-4 sm:p-5">
            <Icon className="size-5 text-violet-hi" aria-hidden="true" />
            <p className="mt-2 font-display text-3xl font-semibold tabular-nums">
              {value}
            </p>
            <p className="mt-1 text-sm text-ink-2">{label}</p>
          </Link>
        ))}
      </div>
      <ExamActivity exams={data.exams} />
    </>
  );
}

export function ExamActivity({ exams }: { exams: Dash["exams"] }) {
  return (
    <section className="d2-card p-5 sm:p-6" id="historique">
      <h2 className="text-xl font-semibold">Activité récente</h2>
      <p className="mt-1 text-sm text-ink-3">Tes derniers examens blancs</p>
      {exams.length ? (
        <ul className="mt-3 divide-y divide-line">
          {exams.slice(0, 4).map((exam) => (
            <li
              key={exam.id}
              className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"
            >
              <Link href={exam.url ?? "/examens"} className="text-violet-hi">
                Examen blanc nº {exam.id}
              </Link>
              <span className="text-ink-3">
                {formatDay(exam.createdAt)} · {exam.questionCount} questions
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-ink-2">
          Aucun examen blanc récent pour ce cours.
        </p>
      )}
    </section>
  );
}
