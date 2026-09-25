"use client";

import { FileCheck2, ExternalLink, CheckCircle2, ClipboardList, WifiOff, RotateCw, Trash2, FileText } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, SectionHeader } from "@/components/ui/primitives";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ExamComposer } from "@/components/examens/ExamComposer";
import { useApi, useCourse, asText } from "@/lib/ux/api";
import { formatDay } from "@/lib/ux/types";
import type { ComposeResp, ExamsResp } from "@/lib/ux/exams";
import { useState } from "react";

export default function ExamensPage() {
  const compose = useApi<ComposeResp>("/api/compose");
  const exams = useApi<ExamsResp>("/api/exams");
  const { courseId } = useCourse();
  const [deleting, setDeleting] = useState<number | null>(null);

  const removeExam = async (id: number) => {
    if (deleting) return;
    if (!window.confirm(`Supprimer l’examen #${id} ? Le PDF généré sera perdu.`)) return;
    setDeleting(id);
    try {
      await fetch(`/api/exams?id=${id}&course=${encodeURIComponent(courseId)}`, { method: "DELETE" });
      exams.refetch();
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title="Examens"
        description="Compose un examen blanc au format réel du final, puis lance-le. Un examen qui aurait pu tomber."
      />

      {/* Compositeur ← GET /api/compose (plan réel, forme variable selon le cours) */}
      {compose.loading ? (
        <div
          className="grid grid-cols-1 gap-5 lg:grid-cols-[1.55fr_1fr]"
          aria-busy="true"
          aria-label="Chargement des examens"
        >
          <div className="skeleton h-96 rounded-xl" />
          <div className="skeleton h-72 rounded-xl" />
        </div>
      ) : compose.error || !compose.data?.plan ? (
        <Panel className="flex flex-col items-center gap-3 rounded-xl px-6 py-12 text-center">
          <FileText className="size-6 text-ink-3" strokeWidth={2} />
          <p className="text-[0.95rem] font-medium text-ink-1">
            {compose.error ? "Le format du cours ne répond pas" : "Format d’examen non détecté"}
          </p>
          <p className="max-w-sm text-[0.85rem] leading-relaxed text-ink-3">
            {compose.error
              ? "Impossible de lire le format détecté pour ce cours. Réessaie dans un instant."
              : "Cortex n’a pas encore détecté le format du final pour ce cours. Importe les annales puis prépare le cours."}
          </p>
          {compose.error ? (
            <Button variant="secondary" size="sm" onClick={compose.refetch}>
              <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
              Réessayer
            </Button>
          ) : (
            <Button variant="primary" size="sm" href="/sources">
              Préparer le cours
            </Button>
          )}
        </Panel>
      ) : (
        <ExamComposer plan={compose.data.plan} onGenerated={exams.refetch} />
      )}

      {/* Examens prêts ← GET /api/exams (réel ; 500 possible sur cs-202) */}
      <section>
        <SectionHeader title="Examens prêts" hint="Générés à ton format, prêts à passer — énoncé et corrigé PDF." />

        {exams.loading ? (
          <div
            className="grid grid-cols-1 gap-3 md:grid-cols-2"
            aria-busy="true"
            aria-label="Chargement des examens prêts"
          >
            {[0, 1].map((i) => (
              <div key={i} className="skeleton h-24 rounded-lg" />
            ))}
          </div>
        ) : exams.error ? (
          <Panel className="flex flex-col items-center gap-3 rounded-xl px-6 py-10 text-center">
            <WifiOff className="size-6 text-danger-hi" strokeWidth={2} />
            <p className="text-[0.95rem] font-medium text-ink-1">Impossible de lister les examens</p>
            <p className="max-w-sm text-[0.85rem] text-ink-3">
              Le moteur renvoie une erreur pour ce cours. Réessaie, ou change de cours.
            </p>
            <Button variant="secondary" size="sm" onClick={exams.refetch}>
              <RotateCw className="size-4" strokeWidth={2.25} aria-hidden="true" />
              Réessayer
            </Button>
          </Panel>
        ) : !exams.data || exams.data.exams.length === 0 ? (
          <Panel className="flex flex-col items-center gap-3 rounded-xl px-6 py-12 text-center">
            <span className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/60 text-ink-3">
              <ClipboardList className="size-5" strokeWidth={2} />
            </span>
            <p className="text-[0.95rem] font-medium text-ink-1">Aucun examen généré</p>
            <p className="max-w-sm text-[0.85rem] leading-relaxed text-ink-3">
              Compose ton premier blanc ci-dessus : Cortex l’assemble au format du vrai final,
              le vérifie exo par exo, et te sort l’énoncé + le corrigé en PDF.
            </p>
          </Panel>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {exams.data.exams.map((e) => {
              const ready = e.status === "ready";
              const summary = asText(e.verifySummary);
              const day = formatDay(e.createdAt);
              return (
                <Panel key={e.id} className="flex items-center gap-4 p-4">
                  <span
                    className="grid size-11 shrink-0 place-items-center rounded-lg border border-line"
                    style={{
                      background: "color-mix(in oklch, var(--color-violet) 12%, var(--color-surface-2))",
                      color: "var(--color-violet-hi)",
                    }}
                  >
                    <FileCheck2 className="size-5" strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-[0.95rem] font-semibold text-ink-1">Examen #{e.id}</h3>
                      <Badge tone={ready ? "success" : "neutral"} Icon={ready ? CheckCircle2 : undefined} size="xs">
                        {ready ? "Prêt" : e.status}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate text-[0.8rem] text-ink-3">
                      {summary ?? `${e.questionCount} question${e.questionCount > 1 ? "s" : ""}`}
                      {day ? ` · ${day}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {e.url && (
                      <a
                        href={e.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-10 items-center gap-1 rounded-md border border-line bg-surface-2/60 px-3 text-[0.8rem] font-medium text-ink-2 transition-colors hover:border-[color-mix(in_oklch,var(--color-violet)_38%,transparent)] hover:text-ink-1"
                      >
                        Énoncé
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                    )}
                    {e.solutionsUrl && (
                      <a
                        href={e.solutionsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-10 items-center gap-1 rounded-md border border-line bg-surface-2/60 px-3 text-[0.8rem] font-medium text-ink-2 transition-colors hover:border-[color-mix(in_oklch,var(--color-emerald)_38%,transparent)] hover:text-ink-1"
                      >
                        Corrigé
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => removeExam(e.id)}
                      disabled={deleting === e.id}
                      aria-label={`Supprimer l’examen #${e.id}`}
                      className="grid size-10 place-items-center rounded-md border border-transparent text-ink-4 transition-colors hover:border-[color-mix(in_oklch,var(--color-danger)_35%,transparent)] hover:text-danger-hi disabled:opacity-50"
                    >
                      <Trash2 className="size-4" strokeWidth={2} />
                    </button>
                  </div>
                </Panel>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
