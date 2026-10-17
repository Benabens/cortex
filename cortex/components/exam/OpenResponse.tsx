"use client";

import { useId, useState } from "react";
import { SafeHtml } from "@/components/ui/SafeHtml";
import type { CheckResult } from "@/lib/check-solution";

export function OpenResponse({ questionId, statement, courseId, graded, solution }: {
  questionId: number;
  statement: string;
  courseId: string;
  graded: boolean;
  solution: string | null;
}) {
  const [answer, setAnswer] = useState("");
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const instanceId = useId();
  const textareaId = `open-response-${questionId}-${instanceId}`;

  async function verifyAnswer() {
    if (!answer.trim() || checking) return;
    setChecking(true);
    setError(null);
    try {
      const response = await fetch(`/api/check-solution?course=${encodeURIComponent(courseId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statement, answer }),
      });
      const data = await response.json();
      if (!response.ok || data.error) setError(data.error ?? "La vérification n’a pas abouti. Réessaie.");
      else setCheck(data.result);
    } catch {
      setError("La vérification n’a pas abouti. Réessaie.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="mt-3">
      <label htmlFor={textareaId} className="mb-1 block text-[12.5px]" style={{ color: "var(--ink-2)" }}>
        Ta réponse
      </label>
      <textarea
        id={textareaId}
        className="textarea w-full"
        rows={4}
        placeholder="Ta réponse (auto-évaluée : le corrigé s’affiche après correction)…"
        style={{ fontSize: 13 }}
        value={answer}
        onChange={(e) => {
          setAnswer(e.target.value);
          setCheck(null);
          setError(null);
        }}
        readOnly={graded}
      />
      {(
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-quiet btn-sm" onClick={verifyAnswer} disabled={!answer.trim() || checking}>
            {checking ? "Vérification…" : "Vérifier ma réponse · 0,1 crédit"}
          </button>
          <span className="text-[11.5px]" style={{ color: "var(--ink-3)" }}>Correction détaillée par critères</span>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-[12px]" style={{ color: "var(--red-ink)" }}>{error}</p>}
      {check && (
        <section className="inset mt-3 p-3" aria-label="Barème de la réponse">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <strong className="text-[14px]" style={{ color: "var(--ink)" }}>Barème</strong>
            <span className="font-data text-[14px] font-semibold" style={{ color: "var(--accent-ink)" }}>{check.score.earned} / {check.score.total} points</span>
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {check.criteria.map((criterion, index) => (
              <li key={`${criterion.label}-${index}`} className="flex items-start gap-2 text-[12.5px]">
                <span aria-hidden="true" className="mt-0.5 shrink-0 font-bold" style={{ color: criterion.achieved ? "var(--green-ink)" : "var(--red-ink)" }}>{criterion.achieved ? "✓" : "✗"}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap justify-between gap-x-3">
                    <strong style={{ color: "var(--ink)" }}>{criterion.label}</strong>
                    <span className="shrink-0 font-data" style={{ color: "var(--ink-2)" }}>{criterion.achieved ? criterion.points : 0} / {criterion.points}</span>
                  </div>
                  <p className="mt-0.5" style={{ color: "var(--ink-2)" }}>{criterion.justification}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12.5px]" style={{ color: "var(--ink-2)" }}>{check.feedback}</p>
        </section>
      )}
      {graded && solution && (
        <details className="mt-3" open>
          <summary className="text-[12.5px] cursor-pointer" style={{ color: "var(--green-ink)" }}>Corrigé</summary>
          <SafeHtml className="prose-exam text-[13px] mt-2" style={{ color: "var(--ink-2)" }} html={solution} />
        </details>
      )}
    </div>
  );
}
