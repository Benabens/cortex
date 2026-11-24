"use client";

import { useId, useState, type ReactNode } from "react";
import { SafeHtml } from "@/components/ui/SafeHtml";
import { MathText } from "@/components/ui/MathText";
import type { CheckResult } from "@/lib/check-solution";
import { UsageLine, useLaunchUsage } from "@/components/billing/UsageIndicator";
import { GenerationWait } from "@/components/generation/GenerationProgress";
import { useTranslations } from "use-intl/react";

export function OpenResponse({ questionId, statement, courseId, graded, solution, solutionContent, part, onChecked, language }: {
  questionId: number;
  statement: string;
  courseId: string;
  graded: boolean;
  /** Corrigé en HTML produit par le serveur, formules comprises (texToHtml katex : questions ouvertes de /mock). */
  solution: string | null;
  /** Corrigé déjà rendu par la vue (question composée), à la place de `solution`. */
  solutionContent?: ReactNode;
  /** Réponse courte d'une question composée : corrigée sur son barème (lu côté serveur). */
  part?: { examId: number; partId: number };
  /** Points obtenus à la vérification (score de l'examen à questions composées). */
  onChecked?: (score: { earned: number; total: number }) => void;
  language?: string;
}) {
  const t = useTranslations("openResponse");
  const [answer, setAnswer] = useState("");
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkStartedAt, setCheckStartedAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const instanceId = useId();
  const textareaId = `open-response-${questionId}-${instanceId}`;
  // Même verdict que POST /api/check-solution (aide) : bouton coupé avant le clic, raison affichée.
  const launch = useLaunchUsage("check");
  const { refresh: refreshUsage } = launch;
  const cost = launch.usage?.costCredits ?? 0.1;
  // Une ligne par question : on ne la montre que quand elle compte (bloqué, ou presque à court).
  const showUsage = launch.usage && (!launch.allowed || (launch.usage.remaining !== null && launch.usage.remaining <= 5));

  async function verifyAnswer() {
    if (!answer.trim() || checking) return;
    setChecking(true);
    setCheckStartedAt(Date.now());
    setError(null);
    try {
      const response = await fetch(`/api/check-solution?course=${encodeURIComponent(courseId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(part ? { examId: part.examId, partId: part.partId, answer } : { statement, answer }),
      });
      const data = await response.json();
      if (!response.ok || data.error) setError(data.error ?? t("failed"));
      else {
        setCheck(data.result);
        onChecked?.(data.result.score);
      }
    } catch {
      setError(t("failed"));
    } finally {
      setChecking(false);
      refreshUsage();
    }
  }

  return (
    <div className="mt-3">
      <label htmlFor={textareaId} className="mb-1 block text-[12.5px]" style={{ color: "var(--ink-2)" }}>
        {t("label")}
      </label>
      <textarea
        id={textareaId}
        className="textarea w-full"
        rows={4}
        placeholder={t("placeholder")}
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
          <button type="button" className="btn btn-quiet btn-sm" onClick={verifyAnswer} disabled={!answer.trim() || checking || !launch.allowed}>
            {checking ? t("checking") : cost > 0 ? t("checkWithCost", { credits: cost }) : t("check")}
          </button>
          <span className="text-[11.5px]" style={{ color: "var(--ink-3)" }}>{t("criteriaHint")}</span>
        </div>
      )}
      {checking && <GenerationWait kind="check" startedAt={checkStartedAt} className="mt-3" />}
      {showUsage && <UsageLine usage={launch.usage} now={launch.now} className="mt-2" />}
      {error && <p role="alert" className="mt-2 text-[12px]" style={{ color: "var(--red-ink)" }}>{error}</p>}
      {check && (
        <section className="inset mt-3 p-3" aria-label={t("rubricLabel")}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <strong className="text-[14px]" style={{ color: "var(--ink)" }}>{t("rubric")}</strong>
            <span className="font-data text-[14px] font-semibold" style={{ color: "var(--accent-ink)" }}>{t("score", { earned: check.score.earned, total: check.score.total })}</span>
          </div>
          {/* Critères et retour : écrits par la correction dans la langue du cours ; le reste est l'interface. */}
          <ul className="mt-3 flex flex-col gap-2" lang={language}>
            {check.criteria.map((criterion, index) => (
              <li key={`${criterion.label}-${index}`} className="flex items-start gap-2 text-[12.5px]">
                <span aria-hidden="true" className="mt-0.5 shrink-0 font-bold" style={{ color: criterion.achieved ? "var(--green-ink)" : "var(--red-ink)" }}>{criterion.achieved ? "✓" : "✗"}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap justify-between gap-x-3">
                    <strong style={{ color: "var(--ink)" }}><MathText text={criterion.label} /></strong>
                    <span className="shrink-0 font-data" style={{ color: "var(--ink-2)" }}>{criterion.achieved ? criterion.points : 0} / {criterion.points}</span>
                  </div>
                  <p className="mt-0.5" style={{ color: "var(--ink-2)" }}><MathText text={criterion.justification} /></p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12.5px]" style={{ color: "var(--ink-2)" }} lang={language}><MathText text={check.feedback} /></p>
        </section>
      )}
      {graded && (solution || solutionContent) && (
        <details className="mt-3" open>
          <summary className="text-[12.5px] cursor-pointer" style={{ color: "var(--green-ink)" }}>{t("solution")}</summary>
          <div lang={language}>{solution
            ? <SafeHtml className="prose-exam text-[13px] mt-2" style={{ color: "var(--ink-2)" }} html={solution} math />
            : <div className="prose-exam text-[13px] mt-2" style={{ color: "var(--ink-2)" }}>{solutionContent}</div>}</div>
        </details>
      )}
    </div>
  );
}
