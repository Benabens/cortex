import Link from "next/link";
import { ArrowRight, Gauge, Grid3x3, History, Target } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/ux/cn";
import { SEVERITY, toneVar, toneText } from "@/lib/ux/labels";
import { asText } from "@/lib/ux/api";
import { toSeverity, type DashStats, type DashWeakness } from "@/lib/ux/types";
import { RadialGauge } from "@/components/viz/RadialGauge";
import { WaffleGrid } from "@/components/viz/WaffleGrid";
import { ForgettingCurve } from "@/components/viz/ForgettingCurve";

function CardHead({
  Icon,
  title,
  action,
}: {
  Icon: LucideIcon;
  title: string;
  action?: { label: string; href: string };
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2 text-[0.72rem] font-medium uppercase tracking-wider text-ink-3">
        <Icon className="size-3.5 text-ink-3" strokeWidth={2.25} />
        {title}
      </div>
      {action && (
        <Link
          href={action.href}
          className="-mx-1.5 -my-3 inline-flex min-h-11 items-center gap-0.5 rounded px-1.5 text-[0.72rem] font-medium text-ink-3 transition-colors hover:text-violet-hi"
        >
          {action.label}
          <ArrowRight className="size-3" />
        </Link>
      )}
    </div>
  );
}

/**
 * Cluster de métriques — 100 % nourri par /api/dashboard (aucun chiffre inventé :
 * pas de tendance hebdo ni de sparkline tant que le back ne les fournit pas).
 */
export function MetricsCluster({
  stats,
  schedule,
  weaknessCount,
  topWeaknesses,
}: {
  stats: DashStats;
  schedule: { total: number; due: number };
  weaknessCount: number;
  topWeaknesses: DashWeakness[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {/* A — Maîtrise pondérée (radial gauge) */}
      <div className="panel flex flex-col p-5 rise-in" style={{ animationDelay: "90ms" }}>
        <CardHead Icon={Gauge} title="Maîtrise pondérée" />
        <div className="grid flex-1 place-items-center pt-2">
          <RadialGauge
            value={stats.masteryPct}
            label="Maîtrise pondérée"
            sublabel={`${stats.mastered} / ${stats.total} maîtrisés`}
            size={158}
          />
        </div>
        <p className="mt-auto border-t border-line pt-3 text-[0.76rem] text-ink-3">
          {stats.masteryPct === 0
            ? "Note tes exos de 0 à 10 : la jauge montera avec toi."
            : "Pondérée par le poids réel de chaque type à l’examen."}
        </p>
      </div>

      {/* B — Programme couvert (waffle grid) */}
      <div className="panel flex flex-col p-5 rise-in" style={{ animationDelay: "120ms" }}>
        <CardHead Icon={Grid3x3} title="Programme couvert" action={{ label: "Programme", href: "/programme" }} />
        <div className="mt-3 flex items-baseline gap-2">
          <span className="font-data text-[2.1rem] font-semibold leading-none text-ink-1">
            {stats.coveragePct}
            <span className="ml-0.5 text-lg text-ink-3">%</span>
          </span>
        </div>
        <p className="mt-1 text-xs text-ink-3">
          {stats.covered} / {stats.total} types de la matière
        </p>
        <div className="mt-auto pt-4">
          <WaffleGrid total={stats.total} filled={stats.covered} columns={9} label="Programme couvert" />
        </div>
      </div>

      {/* C — Révisions dues (forgetting curve — la signature du produit) */}
      <div className="panel flex flex-col p-5 rise-in" style={{ animationDelay: "150ms" }}>
        <CardHead Icon={History} title="Révisions dues" action={{ label: "Réviser", href: "/entrainement" }} />
        <div className="mt-3 flex items-baseline gap-2">
          <span className="font-data text-[2.1rem] font-semibold leading-none text-cyan-hi">
            {schedule.due}
          </span>
          <span className="text-[0.82rem] text-ink-3">
            due{schedule.due > 1 ? "s" : ""} · {schedule.total} planifiée{schedule.total > 1 ? "s" : ""}
          </span>
        </div>
        <p className="mt-1 text-xs text-ink-3">La courbe de l’oubli replanifie au bon moment.</p>
        <div className="mt-auto pt-3">
          <ForgettingCurve width={230} height={78} />
          <p className="mt-1.5 flex items-center gap-1.5 text-[0.72rem] text-ink-3">
            <span className="inline-block size-2 rounded-full ring-2 ring-cyan/70" />
            {schedule.due > 0 ? "Rappel optimal — aujourd’hui" : "Aucun rappel dû aujourd’hui"}
          </p>
        </div>
      </div>

      {/* D — Faiblesses suivies (sévérité réelle) */}
      <div className="panel flex flex-col p-5 rise-in" style={{ animationDelay: "180ms" }}>
        <CardHead Icon={Target} title="Faiblesses suivies" action={{ label: "Détail", href: "/faiblesses" }} />
        <div className="mt-3 flex items-baseline gap-2">
          <span className="font-data text-[2.1rem] font-semibold leading-none text-ink-1">
            {weaknessCount}
          </span>
          {topWeaknesses.some((w) => w.severity >= 3) && (
            <span className="inline-flex items-center gap-1.5 text-[0.82rem] text-danger-hi">
              <span className="inline-block size-1.5 rounded-full bg-danger" />
              sévère{topWeaknesses.filter((w) => w.severity >= 3).length > 1 ? "s" : ""} à traiter
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-ink-3">
          {weaknessCount > 0 ? "Lacunes détectées, en cours de suivi." : "Aucune lacune capturée pour l’instant."}
        </p>

        {topWeaknesses.length > 0 ? (
          <ul className="mt-auto flex flex-col gap-2 pt-4">
            {topWeaknesses.map((w) => {
              const sev = SEVERITY[toSeverity(w.severity)];
              const topic = asText(w.topic) ?? "Faiblesse capturée";
              return (
                <li key={w.id} className="flex items-center gap-2.5">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: toneVar[sev.tone], boxShadow: `0 0 8px -1px ${toneVar[sev.tone]}` }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[0.8rem] text-ink-2">{topic}</span>
                  <span className={cn("shrink-0 text-[0.68rem] font-medium", toneText[sev.tone])}>
                    {sev.label}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-auto pt-4 text-[0.8rem] leading-relaxed text-ink-3">
            Colle une discussion ou dépose un exo raté sur{" "}
            <Link href="/faiblesses" className="font-medium text-violet-hi hover:underline">
              Faiblesses
            </Link>{" "}
            — Cortex en extraira tes lacunes.
          </p>
        )}
      </div>
    </div>
  );
}
