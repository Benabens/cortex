import Link from "next/link";
import { ChevronRight, TrendingUp } from "lucide-react";
import { STATUS } from "@/lib/ux/labels";
import { Badge } from "@/components/ui/Badge";
import { OpportunityBar } from "@/components/viz/OpportunityBar";
import { pointsAtStake, type UiType } from "@/lib/ux/program";
import { cn } from "@/lib/ux/cn";

export function TypeRow({
  t,
  maxWeight,
  index = 0,
}: {
  t: UiType;
  maxWeight: number;
  index?: number;
}) {
  const st = STATUS[t.status];
  const stake = pointsAtStake(t);
  const hot = stake >= 8;
  const cta = t.status === "JAMAIS_VU" ? "Commencer" : "Réviser";
  const masteryLabel = t.mastery10 === null ? "jamais fait" : `maîtrise ${t.mastery10}/10`;

  return (
    <Link
      href="/entrainement"
      aria-label={`${cta} : ${t.title} — poids ${t.weightPct} %, ${masteryLabel}`}
      className="group relative flex flex-col gap-3 rounded-lg px-3 py-3.5 transition-colors hover:bg-surface-2/50 focus-visible:bg-surface-2/50 md:flex-row md:items-center md:gap-5"
    >
      {/* identity */}
      <div className="flex min-w-0 items-start gap-3 md:flex-1">
        <span className="mt-0.5 grid h-6 shrink-0 place-items-center rounded-md border border-line bg-surface-2/70 px-1.5 font-mono text-[0.7rem] font-medium text-ink-3">
          {t.num}
        </span>
        <div className="min-w-0">
          <h4 className="truncate text-[0.95rem] font-medium text-ink-1 transition-colors group-hover:text-white">
            {t.title}
          </h4>
          {t.desc && <p className="mt-0.5 truncate text-[0.8rem] text-ink-3">{t.desc}</p>}
        </div>
      </div>

      {/* opportunity metrics */}
      <div className="md:w-[210px] md:shrink-0 xl:w-[260px]">
        <OpportunityBar
          weightPct={t.weightPct}
          masteryPct={t.masteryPct}
          maxWeight={maxWeight}
          delay={Math.min(index, 6) * 24}
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.72rem] text-ink-3">
          <span className="whitespace-nowrap">
            Poids <span className="font-data font-semibold text-ink-2">{t.weightPct} %</span>
          </span>
          <span className="text-ink-4" aria-hidden="true">·</span>
          <span className="whitespace-nowrap">
            Maîtrise{" "}
            <span className="font-data font-semibold text-ink-2">
              {t.mastery10 === null ? "—" : `${t.mastery10}/10`}
            </span>
          </span>
          {t.examCount > 0 && (
            <>
              <span className="text-ink-4" aria-hidden="true">·</span>
              <span className="whitespace-nowrap">
                <span className="font-data font-semibold text-ink-2">{t.examCount}×</span> aux finals
              </span>
            </>
          )}
        </div>
      </div>

      {/* status + stake + affordance */}
      <div className="flex items-center justify-between gap-3 md:w-[170px] md:shrink-0 md:justify-end xl:w-[190px]">
        <div className="flex items-center gap-2">
          <Badge tone={st.tone} Icon={st.Icon} size="xs">
            {st.label}
          </Badge>
          <span
            aria-label={`${stake} points récupérables à l'examen`}
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.7rem] font-medium tabular",
              hot ? "text-violet-hi" : "text-ink-3"
            )}
            style={
              hot
                ? { background: "color-mix(in oklch, var(--color-violet) 14%, transparent)" }
                : undefined
            }
          >
            <TrendingUp className="size-3" strokeWidth={2.5} />+{stake}
          </span>
        </div>
        <ChevronRight
          className="size-4 shrink-0 text-ink-4 transition-all group-hover:translate-x-0.5 group-hover:text-violet-hi"
          strokeWidth={2.25}
        />
      </div>
    </Link>
  );
}
