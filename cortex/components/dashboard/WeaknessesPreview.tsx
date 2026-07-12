import Link from "next/link";
import { ArrowRight, Target } from "lucide-react";
import { SEVERITY } from "@/lib/ux/labels";
import { asText } from "@/lib/ux/api";
import { toSeverity, type DashWeakness } from "@/lib/ux/types";
import { Panel, SectionHeader } from "@/components/ui/primitives";
import { Badge } from "@/components/ui/Badge";
import { SeverityMeter } from "@/components/viz/SeverityMeter";
import { Button } from "@/components/ui/Button";

/** Aperçu des faiblesses — top réel de /api/dashboard ; état vide qui enseigne. */
export function WeaknessesPreview({
  items,
  total,
}: {
  items: DashWeakness[];
  total: number;
}) {
  return (
    <Panel className="p-5">
      <SectionHeader
        title="Tes faiblesses"
        hint="Les lacunes qui te coûtent le plus de points."
        action={total > 0 ? { label: `Les ${total}`, href: "/faiblesses" } : undefined}
      />

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <span className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/60 text-ink-3">
            <Target className="size-5" strokeWidth={2} />
          </span>
          <div>
            <p className="text-[0.9rem] font-medium text-ink-1">Aucune faiblesse capturée</p>
            <p className="mx-auto mt-1 max-w-xs text-[0.8rem] leading-relaxed text-ink-3">
              Colle une discussion ou dépose un exo raté : Cortex en extrait tes lacunes
              et te propose un drill ciblé.
            </p>
          </div>
          <Button variant="secondary" size="sm" href="/faiblesses">
            Capturer une faiblesse
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col">
          {items.map((w, i) => {
            const sev = SEVERITY[toSeverity(w.severity)];
            const topic = asText(w.topic) ?? "Faiblesse capturée";
            return (
              <li key={w.id}>
                {i > 0 && <div className="h-px bg-line" />}
                <div className="group -mx-2 flex flex-col gap-2.5 rounded-lg px-2 py-3 transition-colors hover:bg-surface-2/60 sm:flex-row sm:items-center sm:gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <SeverityMeter level={sev.level} tone={sev.tone} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-[0.9rem] text-ink-1">{topic}</span>
                  </div>
                  <div className="flex shrink-0 items-center justify-between gap-3 pl-7 sm:justify-end sm:pl-0">
                    <Badge tone={sev.tone} Icon={sev.Icon} size="xs">
                      {sev.label}
                    </Badge>
                    <Link
                      href={`/entrainement?drill=${encodeURIComponent(topic)}`}
                      aria-label={`Driller : ${topic}`}
                      className="inline-flex h-10 shrink-0 items-center gap-1 rounded-md border border-line bg-surface-2/60 px-3 text-[0.8rem] font-medium text-ink-2 transition-colors hover:border-[color-mix(in_oklch,var(--color-violet)_38%,transparent)] hover:text-ink-1"
                    >
                      Driller
                      <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
