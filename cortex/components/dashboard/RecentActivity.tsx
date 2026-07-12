import { FileText, ExternalLink, ClipboardList } from "lucide-react";
import { Panel, SectionHeader } from "@/components/ui/primitives";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { asText } from "@/lib/ux/api";
import { formatDay, type DashExam } from "@/lib/ux/types";

/**
 * Examens & exos récents — exams réels de /api/dashboard. Pas de score inventé :
 * le back ne renvoie pas de note ici, on montre statut + accès énoncé/corrigé.
 */
export function RecentActivity({ exams }: { exams: DashExam[] }) {
  return (
    <Panel className="p-5">
      <SectionHeader
        title="Examens & exos récents"
        hint="Tes derniers examens générés, le plus récent d’abord."
        action={exams.length > 0 ? { label: "Tous", href: "/examens" } : undefined}
      />

      {exams.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <span className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/60 text-ink-3">
            <ClipboardList className="size-5" strokeWidth={2} />
          </span>
          <div>
            <p className="text-[0.9rem] font-medium text-ink-1">Aucun examen généré</p>
            <p className="mx-auto mt-1 max-w-xs text-[0.8rem] leading-relaxed text-ink-3">
              Compose ton premier final blanc, calibré sur le format réel du cours.
            </p>
          </div>
          <Button variant="secondary" size="sm" href="/examens">
            Composer un examen
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col">
          {exams.map((e, i) => {
            const summary = asText(e.verifySummary);
            const day = formatDay(e.createdAt);
            const ready = e.status === "ready";
            return (
              <li key={e.id}>
                {i > 0 && <div className="h-px bg-line" />}
                <div className="group -mx-2 flex items-center gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-surface-2/60">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-surface-2/60 text-ink-3">
                    <FileText className="size-[1.05rem]" strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[0.9rem] font-medium text-ink-1">
                      Examen #{e.id}
                    </p>
                    <p className="truncate text-[0.76rem] text-ink-3">
                      {summary ?? `${e.questionCount} question${e.questionCount > 1 ? "s" : ""}`}
                      {day ? ` · ${day}` : ""}
                    </p>
                  </div>
                  <Badge tone={ready ? "success" : "neutral"} size="xs">
                    {ready ? "Prêt" : e.status}
                  </Badge>
                  {e.url && (
                    <a
                      href={e.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface-2/60 px-3 text-[0.8rem] font-medium text-ink-2 transition-colors hover:border-[color-mix(in_oklch,var(--color-violet)_38%,transparent)] hover:text-ink-1"
                    >
                      Ouvrir
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                      <span className="sr-only">(PDF, nouvel onglet)</span>
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
