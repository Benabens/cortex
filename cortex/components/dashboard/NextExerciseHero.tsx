import { Sparkles, ArrowRight, Play, Target, Layers } from "lucide-react";
import { STATUS } from "@/lib/ux/labels";
import { toStatus } from "@/lib/ux/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { WeightBar } from "@/components/viz/WeightBar";

/**
 * Héro « prochain exo » — nourri par dashboard.next (données réelles).
 * `mastery` est sur 0–10 côté back ; la barre « Ta maîtrise » l'affiche en /10.
 */
export function NextExerciseHero({
  title,
  theme,
  weightPct,
  status,
  mastery,
}: {
  title: string;
  theme: string | null;
  weightPct: number;
  status: string;
  mastery: number | null;
}) {
  const st = STATUS[toStatus(status, mastery)];
  const neverSeen = mastery === null;
  // Priorité dérivée (qualitative) : poids fort + jamais vu = meilleur retour sur ton temps.
  const priority = Math.min(100, weightPct * 4 + (neverSeen ? 24 : 0));

  return (
    <section
      className="panel accent-field relative overflow-hidden rounded-xl p-1 rise-in"
      style={{ animationDelay: "60ms", boxShadow: "var(--shadow-card), var(--shadow-glow-violet)" }}
      aria-labelledby="next-title"
    >
      {/* soft corner light */}
      <div
        className="pointer-events-none absolute -right-24 -top-24 size-64 rounded-full opacity-60 blur-3xl"
        style={{
          background:
            "radial-gradient(circle, color-mix(in oklch, var(--color-violet) 42%, transparent), transparent 70%)",
        }}
        aria-hidden="true"
      />

      <div className="relative grid grid-cols-1 gap-5 rounded-[16px] p-5 sm:p-7 lg:grid-cols-[1.45fr_1fr] lg:gap-8">
        {/* Left: the recommendation */}
        <div className="flex flex-col">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-[0.75rem] font-semibold uppercase tracking-wide text-violet-hi">
              <Sparkles className="size-3.5" strokeWidth={2.5} />
              Recommandé pour toi
            </span>
          </div>

          <h2 id="next-title" className="mt-3 text-[1.7rem] font-semibold leading-[1.12] sm:text-[2rem]">
            {title}
          </h2>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {theme && (
              <Badge tone="violet" Icon={Layers}>
                {theme}
              </Badge>
            )}
            <Badge tone={st.tone} Icon={st.Icon}>
              {st.label}
            </Badge>
          </div>

          <p className="mt-4 max-w-md text-[0.95rem] leading-relaxed text-ink-2">
            {neverSeen
              ? "Fort poids à l’examen et jamais travaillé : le meilleur retour sur ton temps aujourd’hui. Un exercice au format du vrai final t’attend."
              : "C’est le moment optimal pour y revenir — un exercice neuf au format du vrai final t’attend."}
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button variant="primary" size="lg" href="/entrainement">
              <Play className="size-4" strokeWidth={2.5} fill="currentColor" />
              M’entraîner
              <ArrowRight className="size-4" strokeWidth={2.5} />
            </Button>
            <Button variant="secondary" size="lg" href="/programme">
              Voir le thème
            </Button>
          </div>
        </div>

        {/* Right: why now — weight vs mastery gap (exam-truthful) */}
        <div className="rounded-lg border border-line bg-surface-2/40 p-4 edge-top sm:p-5">
          <div className="flex items-center gap-2 text-[0.72rem] font-medium uppercase tracking-wider text-ink-3">
            <Target className="size-3.5 text-cyan-hi" strokeWidth={2.5} />
            Pourquoi maintenant
          </div>

          <div className="mt-4 space-y-4">
            <StatRow
              label="Priorité"
              value={<span className="text-violet-hi">Élevée</span>}
              fill={priority}
              glow
            />
            <StatRow
              label="Ta maîtrise"
              value={neverSeen ? "—" : `${mastery}/10`}
              fill={neverSeen ? 0 : Math.max(0, Math.min(100, (mastery ?? 0) * 10))}
              from="var(--color-ink-4)"
              to="var(--color-ink-3)"
            />
          </div>

          <div className="mt-5 border-t border-line pt-4">
            <p className="text-[0.85rem] leading-relaxed text-ink-2">
              <span className="font-data font-semibold text-ink-1">{weightPct} %</span> de
              l’examen{neverSeen ? ", jamais travaillé — le plus gros écart du programme." : " — chaque point regagné compte."}
              <span className="text-ink-1"> Chaque point ici est à portée.</span>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function StatRow({
  label,
  value,
  fill,
  from,
  to,
  glow,
}: {
  label: string;
  value: React.ReactNode;
  fill: number;
  from?: string;
  to?: string;
  glow?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[0.82rem] text-ink-2">{label}</span>
        <span className="font-data text-[0.95rem] font-semibold text-ink-1">{value}</span>
      </div>
      <WeightBar pct={fill} from={from} to={to} glow={glow} height={7} />
    </div>
  );
}
