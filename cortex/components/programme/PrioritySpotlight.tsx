import Link from "next/link";
import { ArrowUpRight, Flame } from "lucide-react";
import { STATUS } from "@/lib/ux/labels";
import { Badge } from "@/components/ui/Badge";
import { OpportunityBar } from "@/components/viz/OpportunityBar";
import { byPriority, pointsAtStake, type UiType } from "@/lib/ux/program";

/** Top 3 des types au meilleur retour sur le temps — dérivé des topics réels. */
export function PrioritySpotlight({ types, maxWeight }: { types: UiType[]; maxWeight: number }) {
  const top = byPriority(types).slice(0, 3);
  if (top.length === 0) return null;

  return (
    <section aria-labelledby="spotlight-title" >
      <div className="mb-3 flex items-center gap-2">
        <Flame className="size-4 text-warning" strokeWidth={2.25} />
        <h2 id="spotlight-title" className="text-[0.95rem] font-semibold text-ink-1">
          Ce qui rapporte le plus
        </h2>
        <span className="text-[0.8rem] text-ink-3">— gros poids, maîtrise faible</span>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {top.map((t, i) => {
          const st = STATUS[t.status];
          const stake = pointsAtStake(t);
          const cta = t.status === "JAMAIS_VU" ? "Commencer" : "Réviser";
          return (
            <Link
              key={t.key}
              href="/entrainement"
              aria-label={`Priorité n°${i + 1} : ${cta} ${t.title}, ${stake} points à gagner`}
              className="panel accent-field group relative flex flex-col gap-3 rounded-xl p-5 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-[color-mix(in_oklch,var(--color-violet)_38%,transparent)] hover:shadow-[var(--shadow-pop)]"
              
            >
              <div className="flex items-start justify-between">
                <span
                  className="grid size-7 place-items-center rounded-lg font-data text-[0.8rem] font-semibold text-white"
                  style={{ background: "linear-gradient(150deg, var(--color-violet), var(--color-cyan))" }}
                >
                  {i + 1}
                </span>
                <div className="text-right">
                  <div className="font-data text-[1.6rem] font-semibold leading-none text-violet-hi">
                    +{stake}
                  </div>
                  <div className="text-[0.68rem] text-ink-3">pts à gagner</div>
                </div>
              </div>

              <div className="min-w-0">
                <h3 className="text-[1.02rem] font-semibold leading-snug text-ink-1">{t.title}</h3>
                <p className="mt-0.5 text-[0.78rem] text-ink-3">
                  {t.sectionN}. {t.section}
                </p>
              </div>

              <OpportunityBar
                weightPct={t.weightPct}
                masteryPct={t.masteryPct}
                maxWeight={maxWeight}
                height={10}
                delay={100 + i * 50}
              />

              <div className="mt-auto flex items-center justify-between pt-1">
                <Badge tone={st.tone} Icon={st.Icon} size="xs">
                  {st.label}
                </Badge>
                <span className="inline-flex items-center gap-1 text-[0.8rem] font-medium text-ink-2 transition-colors group-hover:text-violet-hi">
                  {cta}
                  <ArrowUpRight className="size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
