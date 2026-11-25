"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { SafeHtml } from "@/components/ui/SafeHtml";
import { MathText } from "@/components/ui/MathText";
import { UsageLine, useLaunchUsage } from "@/components/billing/UsageIndicator";
import { GenerationProgress } from "@/components/generation/GenerationProgress";
import { useJobError } from "@/components/generation/useJobError";
import { webAssistJobs, jobEnd, jobInUrl, rememberJobInUrl, useJob, withCourse } from "@/lib/ux/api";
import { notifyJobStarted } from "@/lib/ux/generation-tracker";
import { questionOfTarget } from "@/lib/ux/generation";
import { useTranslations } from "use-intl/react";

/**
 * Réponse rédigée et sa correction par critères. La correction est un JOB (POST /api/check-solution,
 * lib/check-job) qui porte la question corrigée : quitter la page ou recharger ne la perd plus. Au
 * retour, la question reprend le suivi de sa correction en cours ; une correction prête est relue
 * par son job (`?job=`, lien de la notification de fin), réponse comprise.
 */
export function OpenResponse({ questionId, examId, statement, courseId, graded, solution, solutionContent, part, onChecked, language }: {
  questionId: number;
  /** Examen de la question (questions ouvertes de /mock) : la correction la retrouve au retour sur la page. */
  examId?: number;
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
  const jobErrorText = useJobError();
  const [answer, setAnswer] = useState("");
  const [jobId, setJobId] = useState<number | null>(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = useJob(jobId);
  const end = job ? jobEnd(job.status) : null;
  const check = end === "done" ? job?.check ?? null : null;
  const checking = launching || (job != null && end === null);
  const failed = end === "failed" || (end === "done" && !check) ? jobErrorText(job?.error) ?? t("failed") : null;
  const instanceId = useId();
  const textareaId = `open-response-${questionId}-${instanceId}`;
  // Même verdict que POST /api/check-solution (aide) : bouton coupé avant le clic, raison affichée.
  const launch = useLaunchUsage("check");
  const { refresh: refreshUsage } = launch;
  const cost = launch.usage?.costCredits ?? 0.1;
  // Une ligne par question : on ne la montre que quand elle compte (bloqué, ou presque à court).
  const showUsage = launch.usage && (!launch.allowed || (launch.usage.remaining !== null && launch.usage.remaining <= 5));

  // La question corrigée, portée par le job : c'est par elle que la page la retrouve.
  const question = part ? { examId: part.examId, questionId: part.partId } : examId != null ? { examId, questionId } : null;
  const qKey = question ? `${question.examId}:${question.questionId}` : null;

  // Retour sur la page : la dernière correction de CETTE question, en cours ou finie (pendant
  // l'absence, avant un rechargement), et ses points dans le score ; sinon celle de l'adresse.
  useEffect(() => {
    if (!qKey || !courseId) return;
    let alive = true;
    const mine = (target: string | null | undefined) => {
      const q = questionOfTarget(target);
      return !!q && `${q.examId}:${q.questionId}` === qKey;
    };
    void (async () => {
      const last = (await webAssistJobs(courseId, "check")).find((j) => mine(j.target));
      if (last) { if (alive) setJobId(last.id); return; }
      const linked = jobInUrl(courseId);
      if (!linked) return;
      const j = await fetch(withCourse(`/api/jobs/${linked}`, courseId)).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { id: number; type: string; target: string | null } | null;
      if (alive && j?.type === "check" && mine(j.target)) setJobId(j.id);
    })();
    return () => { alive = false; };
  }, [qKey, courseId]);

  // Correction reprise : la réponse corrigée revient dans le champ (une fois par job, au rendu).
  const [restored, setRestored] = useState<number | null>(null);
  if (job && restored !== job.id) {
    setRestored(job.id);
    if (!answer) setAnswer(sentAnswer(job.target));
  }

  // Correction prête : ses points comptent dans le score (examen à questions composées), une fois.
  const reported = useRef<number | null>(null);
  useEffect(() => {
    if (!check || !job || reported.current === job.id) return;
    reported.current = job.id;
    onChecked?.(check.score);
  }, [check, job, onChecked]);

  async function verifyAnswer() {
    if (!answer.trim() || checking) return;
    setLaunching(true);
    setError(null);
    setJobId(null);
    try {
      const response = await fetch(`/api/check-solution?course=${encodeURIComponent(courseId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(part ? { examId: part.examId, partId: part.partId, answer } : { statement, answer, ...question }),
      });
      const data = await response.json().catch(() => null) as { jobId?: number; error?: string } | null;
      if (!response.ok || !data?.jobId) setError(data?.error ?? t("failed"));
      else {
        setJobId(data.jobId);
        rememberJobInUrl(data.jobId, courseId);
        notifyJobStarted();
      }
    } catch {
      setError(t("failed"));
    } finally {
      setLaunching(false);
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
          // Réponse modifiée : la correction affichée n'est plus la sienne.
          setJobId(null);
          setError(null);
        }}
        readOnly={graded || checking}
      />
      {(
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-quiet btn-sm" onClick={verifyAnswer} disabled={!answer.trim() || checking || !launch.allowed}>
            {checking ? t("checking") : cost > 0 ? t("checkWithCost", { credits: cost }) : t("check")}
          </button>
          <span className="text-[11.5px]" style={{ color: "var(--ink-3)" }}>{t("criteriaHint")}</span>
        </div>
      )}
      {/* Une aide : elle ne s'annule pas (son prix est réglé au lancement). */}
      {checking && <GenerationProgress job={job} cancelable={false} meanwhile={false} className="mt-3" />}
      {showUsage && <UsageLine usage={launch.usage} now={launch.now} className="mt-2" />}
      {(error ?? failed) && <p role="alert" className="mt-2 text-[12px]" style={{ color: "var(--red-ink)" }}>{error ?? failed}</p>}
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

/** La réponse envoyée à la correction, relue dans la cible du job. */
function sentAnswer(target: string | null | undefined): string {
  try {
    return String((JSON.parse(target ?? "{}") as { answer?: unknown }).answer ?? "");
  } catch {
    return "";
  }
}
