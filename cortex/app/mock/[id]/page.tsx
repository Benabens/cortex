"use client";

import { ExamFrame } from "@/components/exam/ExamFrame";
import styles from "@/components/exam/exam.module.css";

import {
  use,
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
} from "react";
import { useCourse } from "@/lib/ux/api";
import { useReducedMotion } from "@/lib/ux/hooks";
import { SafeHtml } from "@/components/ui/SafeHtml";
import { MathText } from "@/components/ui/MathText";
import { OpenResponse } from "@/components/exam/OpenResponse";
import { ReportButton } from "@/components/exam/ReportButton";
import { BlockExam } from "@/components/exam/BlockExam";
import type { BlockExamView } from "@/lib/blocks";
import type { QcmGradeDetail } from "@/lib/qcm";
import { useTranslations } from "use-intl/react";
import { useFmt } from "@/lib/i18n/use-fmt";

type Item = {
  id: number;
  idx: number;
  topic: string;
  type: "scq" | "mcq";
  stem: string;
  options: string[];
  verified: number | null;
};
type Open = {
  id: number;
  concept: string;
  statement: string;
  /** L'énoncé sans KaTeX, pour la correction (absent d'une réponse d'avant ce champ). */
  checkStatement?: string;
  solution: string;
};
type Exam = {
  id: number;
  status?: string;
  verifySummary: string | null;
  pdf: string | null;
  solutions?: string | null;
  items: Item[];
  open: Open[];
};
type Graded = {
  score: number;
  total: number;
  detail: QcmGradeDetail[];
  openSolutions: Open[];
};

const LETTER = "ABCDEFGH".split("");
export default function MockPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const t = useTranslations("mockPage");
  const { courseId, ready } = useCourse();
  if (!ready || !courseId)
    return (
      <div
        className="skeleton h-48 rounded-xl"
        aria-label={t("loadingCourse")}
      />
    );
  return <MockExam key={`${courseId}:${id}`} id={id} courseId={courseId} />;
}

function MockExam({ id, courseId }: { id: string; courseId: string }) {
  const t = useTranslations("mockPage");
  const f = useFmt();
  const { course } = useCourse();
  const language = course?.language || undefined; // "" = langue pas encore détectée : pas de lang vide
  const reducedMotion = useReducedMotion();
  const qs = `?course=${encodeURIComponent(courseId ?? "")}`;
  const [retry, setRetry] = useState(0);
  const [exam, setExam] = useState<Exam | null>(null);
  // Examen à questions composées (lib/blocks) : sa propre vue.
  const [blocks, setBlocks] = useState<BlockExamView | null>(null);
  const [answers, setAnswers] = useState<Record<number, number[]>>({});
  const [graded, setGraded] = useState<Graded | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 404 : l'examen n'existe pas (ou plus) dans ce cours ; « Réessayer » ne pourrait rien y changer.
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!courseId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch(`/api/qcm/${id}${qs}`);
        const d = await response.json();
        if (!response.ok && !d.error) d.error = t("loadingFailed");
        if (stop) return;
        setMissing(response.status === 404);
        if (d.error) setErr(d.error);
        else if (d.kind === "blocks") setBlocks(d);
        else setExam(d);
        // Livraison progressive : les QCM sont là, les questions ouvertes arrivent → on repasse.
        if (!d.error && d.status === "generating")
          timer = setTimeout(load, 15_000);
      } catch {
        if (!stop) setErr(t("loadingFailed"));
      }
    };
    load();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, courseId, qs, retry, t]);

  const toggle = useCallback(
    (it: Item, k: number) => {
      if (graded) return;
      setAnswers((a) => {
        const cur = a[it.idx] ?? [];
        if (it.type === "scq") return { ...a, [it.idx]: [k] };
        return {
          ...a,
          [it.idx]: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k],
        };
      });
    },
    [graded],
  );

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const d = await (
        await fetch(`/api/qcm/${id}/grade${qs}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers }),
        })
      ).json();
      if (d.error) setErr(d.error);
      else {
        setGraded(d);
        window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
      }
    } catch {
      setErr(t("correctionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const detailFor = (idx: number) => graded?.detail.find((d) => d.idx === idx);

  if (blocks)
    return <BlockExam exam={blocks} courseId={courseId ?? ""} qs={qs} />;
  if (err && !exam)
    return (
      <div className={styles.exam}>
        <div
          role="alert"
          className="card card-pad"
          style={{ color: "var(--red-ink)" }}
        >
          {err}
          {missing ? (
            <>
              <p className="mt-2" style={{ color: "var(--ink-2)" }}>{t("notFoundHint")}</p>
              <a href={`/examens${qs}`} className="btn btn-ghost mt-3">{t("backToExams")}</a>
            </>
          ) : (
            <button
              className="btn btn-ghost mt-3"
              onClick={() => {
                setErr(null);
                setRetry((value) => value + 1);
              }}
            >
              {t("retry")}
            </button>
          )}
        </div>
      </div>
    );
  if (!exam)
    return (
      <div className={styles.exam}>
        <div className="skeleton" style={{ height: 200 }} />
      </div>
    );

  return (
    <ExamFrame
      id={exam.id}
      description={t("description", { choices: exam.items.length, open: exam.open.length })}
      pdf={exam.pdf}
      solutions={exam.solutions}
      qs={qs}

    >
      {err && (
        <div
          role="alert"
          className="card card-pad mb-4"
          style={{ color: "var(--red-ink)" }}
        >
          {err}
        </div>
      )}

      {graded && (
        <div
          className="card card-pad mb-6 rise"
          style={{
            borderColor: "var(--accent-line)",
            boxShadow: "var(--shadow-accent)",
          }}
        >
          <div className="flex items-center gap-4">
            <div
              className="ring"
              style={
                {
                  "--val": graded.total
                    ? Math.round((graded.score / graded.total) * 100)
                    : 0,
                  "--c": "var(--accent)",
                } as CSSProperties
              }
            >
              <span>
                {graded.total
                  ? Math.round((graded.score / graded.total) * 100)
                  : 0}
                %
              </span>
            </div>
            <div>
              <div className="stat-value">
                {f.number(graded.score)} / {f.number(graded.total)}
              </div>
              <div className="stat-label">
                {t("scoreHint")}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {exam.items.map((it) => {
          const det = detailFor(it.idx);
          const chosen = answers[it.idx] ?? [];
          return (
            <section
              key={it.id}
              id={`question-${it.id}`}
              className="card card-pad"
              style={
                det
                  ? { borderColor: det.ok ? "var(--green)" : "var(--red)" }
                  : undefined
              }
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <span
                  className="text-[12.5px]"
                  style={{ color: "var(--ink-3)" }}
                >
                  Q{it.idx + 1} · <span lang={language}>{it.topic}</span> ·{" "}
                  {/* Un seul accent : il signale le cas qui change la façon de répondre (plusieurs cases). */}
                  <span style={it.type === "mcq" ? { color: "var(--accent-ink)" } : undefined}>
                    {it.type === "mcq" ? t("multipleAnswers") : t("singleAnswer")}
                  </span>
                </span>
                {det && (
                  <span
                    className={`tag ${det.ok ? "tag-green" : det.points > 0 ? "tag-amber" : "tag-red"}`}
                  >
                    {f.number(det.points)} / 1{det.ok ? " ✓" : ""}
                  </span>
                )}
              </div>
              <div
                className="text-[14.5px] mb-3"
                lang={language}
                style={{ color: "var(--ink)", whiteSpace: "pre-wrap" }}
              >
                <MathText text={it.stem} />
              </div>
              {it.type === "mcq" && !graded && (
                <p
                  className="mb-3 text-[12px]"
                  style={{ color: "var(--ink-3)" }}
                >
                  {t("multipleHint")}
                </p>
              )}
              <div className="flex flex-col gap-1.5">
                {it.options.map((o, k) => {
                  const picked = chosen.includes(k);
                  const isCorrect = det?.correct.includes(k);
                  const wrongPick = det && picked && !isCorrect;
                  const bg = det
                    ? isCorrect
                      ? "var(--green-wash)"
                      : wrongPick
                        ? "var(--red-wash)"
                        : "var(--surface-inset)"
                    : picked
                      ? "var(--accent-wash)"
                      : "var(--surface-inset)";
                  const bd = det
                    ? isCorrect
                      ? "var(--green)"
                      : wrongPick
                        ? "var(--red)"
                        : "var(--line)"
                    : picked
                      ? "var(--accent-line)"
                      : "var(--line)";
                  return (
                    <button
                      key={k}
                      onClick={() => toggle(it, k)}
                      disabled={!!graded}
                      aria-pressed={picked}
                      className="inset"
                      style={{
                        display: "flex",
                        gap: 10,
                        alignItems: "flex-start",
                        padding: "9px 12px",
                        textAlign: "left",
                        background: bg,
                        border: `1px solid ${bd}`,
                        cursor: graded ? "default" : "pointer",
                      }}
                    >
                      <span
                        style={{
                          width: 22,
                          height: 22,
                          flex: "none",
                          borderRadius: it.type === "mcq" ? 6 : 999,
                          border: `1.5px solid ${bd}`,
                          display: "grid",
                          placeItems: "center",
                          fontSize: 12,
                          fontWeight: 700,
                          color: "var(--ink-2)",
                        }}
                      >
                        {LETTER[k]}
                      </span>
                      <span
                        lang={language}
                        style={{ fontSize: 13.5, color: "var(--ink)", flex: 1 }}
                      >
                        <MathText text={o} />
                      </span>
                      {det && isCorrect && (
                        <span
                          style={{ color: "var(--green-ink)", fontSize: 13 }}
                        >
                          ✓
                        </span>
                      )}
                      {det &&
                        wrongPick &&
                        it &&
                        (det.misconceptions[k] ? (
                          <span
                            style={{
                              color: "var(--red-ink)",
                              fontSize: 11.5,
                              maxWidth: 220,
                            }}
                          >
                            ⚠ <span lang={language}><MathText text={det.misconceptions[k]} /></span>
                          </span>
                        ) : (
                          <span style={{ color: "var(--red-ink)" }}>✗</span>
                        ))}
                    </button>
                  );
                })}
              </div>
              {det && det.explanation && (
                <p
                  className="mt-3 text-[12.5px]"
                  style={{ color: "var(--ink-2)", whiteSpace: "pre-line" }}
                >
                  <strong style={{ color: "var(--ink)" }}>{t("why")}</strong>{" "}
                  <span lang={language}><MathText text={det.explanation} /></span>
                </p>
              )}
              <ReportButton
                courseId={courseId ?? ""}
                examId={Number(id)}
                kind="qcm"
                itemId={it.id}
              />
            </section>
          );
        })}
      </div>

      {exam.status === "generating" && (
        <p className="mt-7 text-[13px]" style={{ color: "var(--ink-3)" }}>
          {t("openGenerating")}
        </p>
      )}
      {exam.open.length > 0 && (
        <div className="mt-7">
          <div className="section-head">
            <h2 className="section-title">
              {t("openPart", { count: exam.open.length })}
            </h2>
          </div>
          <div className="flex flex-col gap-4">
            {exam.open.map((o, i) => {
              const sol = graded?.openSolutions.find((s) => s.id === o.id);
              return (
                <section key={o.id} className="card card-pad">
                  <div
                    className="text-[12.5px] mb-2"
                    style={{ color: "var(--ink-3)" }}
                  >
                    {t("openQuestion", { number: i + 1 })} · <span lang={language}>{o.concept}</span>
                  </div>
                  <div lang={language}><SafeHtml
                      className="prose-exam text-[13.5px]"
                      style={{ color: "var(--ink)" }}
                      html={o.statement}
                      math
                    /></div>
                  <OpenResponse
                    key={`${courseId}:${id}:${o.id}`}
                    questionId={o.id}
                    examId={Number(id)}
                    statement={o.checkStatement ?? o.statement}
                    courseId={courseId ?? ""}
                    graded={!!graded}
                    solution={sol?.solution ?? null}
                    language={language}
                  />
                  <ReportButton
                    courseId={courseId ?? ""}
                    examId={Number(id)}
                    kind="open"
                    itemId={o.id}
                  />
                </section>
              );
            })}
          </div>
        </div>
      )}

      {!graded ? (
        <div
          id="exam-submit"
          className="mt-6 flex flex-wrap items-center gap-3"
        >
          <button
            className="btn btn-primary btn-lg"
            onClick={submit}
            disabled={
              busy ||
              exam.items.filter((item) => (answers[item.idx]?.length ?? 0) > 0)
                .length === 0
            }
          >
            {busy ? t("correcting") : t("correct")}
          </button>
          <span className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
            {t("answered", {
              answered: exam.items.filter((item) => (answers[item.idx]?.length ?? 0) > 0).length,
              total: exam.items.length,
            })}
          </span>
        </div>
      ) : (
        <div id="exam-submit" className="mt-6">
          <a href={`/examens${qs}`} className="btn btn-ghost">
            {t("back")}
          </a>
        </div>
      )}
    </ExamFrame>
  );
}
