"use client";

import { ExamFrame } from "./ExamFrame";

import { useState, type CSSProperties } from "react";
import { OpenResponse } from "@/components/exam/OpenResponse";
import { ReportButton } from "@/components/exam/ReportButton";
import type {
  BlockExamView,
  PartGrade,
  PartKind,
  PartView,
} from "@/lib/blocks";

type Graded = {
  score: number;
  total: number;
  pending: number;
  detail: PartGrade[];
};

const LETTER = "ABCDEFGH".split("");
const KIND_LABEL: Record<PartKind, string> = {
  scq: "Choix unique",
  short: "Réponse courte",
  code_output: "Lecture de code",
};
const formatPoints = (value: number) =>
  new Intl.NumberFormat("fr-CH", { maximumFractionDigits: 2 }).format(value);
const codeStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  background: "var(--surface-inset)",
  border: "1px solid var(--line)",
  borderRadius: 8,
  padding: "10px 12px",
  overflowX: "auto",
  whiteSpace: "pre",
  color: "var(--ink)",
  margin: "8px 0",
};
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Texte du scénario : paragraphes, blocs ```…``` en code. */
function Rich({ text }: { text: string }) {
  const chunks: { code: boolean; body: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(/```[\w+-]*\n?([\s\S]*?)```/g)) {
    if (m.index! > last)
      chunks.push({ code: false, body: text.slice(last, m.index) });
    chunks.push({ code: true, body: m[1].replace(/\s+$/, "") });
    last = m.index! + m[0].length;
  }
  if (last < text.length) chunks.push({ code: false, body: text.slice(last) });
  return (
    <>
      {chunks
        .filter((c) => c.body.trim())
        .map((c, i) =>
          c.code ? (
            <pre key={i} style={codeStyle}>
              {c.body}
            </pre>
          ) : (
            <p
              key={i}
              className="text-[14px]"
              style={{
                color: "var(--ink)",
                whiteSpace: "pre-wrap",
                margin: "6px 0",
              }}
            >
              {c.body.trim()}
            </p>
          ),
        )}
    </>
  );
}

/**
 * Examen à QUESTIONS COMPOSÉES (lib/blocks) : par question, le scénario puis ses
 * sous-questions. Choix unique et lecture de code se corrigent d'un coup ; une réponse
 * courte se vérifie critère par critère sur son barème (0,1 crédit), révélé à la correction.
 */
export function BlockExam({
  exam,
  courseId,
  qs,
}: {
  exam: BlockExamView;
  courseId: string;
  qs: string;
}) {
  const [answers, setAnswers] = useState<Record<number, number | string>>({});
  const [graded, setGraded] = useState<Graded | null>(null);
  // Réponses courtes vérifiées critère par critère : leurs points s'ajoutent au score.
  const [checked, setChecked] = useState<
    Record<number, { earned: number; total: number }>
  >({});
  const shortScore = Object.values(checked).reduce(
    (s, c) => ({ earned: s.earned + c.earned, total: s.total + c.total }),
    { earned: 0, total: 0 },
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const parts = exam.blocks.flatMap((b) => b.parts);
  const autoParts = parts.filter((p) => p.kind !== "short");
  const answered = autoParts.filter(
    (p) => answers[p.id] !== undefined && answers[p.id] !== "",
  ).length;
  const detailFor = (id: number) => graded?.detail.find((d) => d.partId === id);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const d = await (
        await fetch(`/api/qcm/${exam.id}/grade${qs}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ blockAnswers: answers }),
        })
      ).json();
      if (d.error) setErr(d.error);
      else {
        setGraded(d);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch {
      setErr("Correction impossible.");
    } finally {
      setBusy(false);
    }
  }

  const renderPart = (p: PartView, k: number) => {
    const det = detailFor(p.id);
    const given = answers[p.id];
    return (
      <div
        key={p.id}
        className="mt-4"
        style={{
          borderTop: k ? "1px solid var(--line)" : undefined,
          paddingTop: k ? 14 : 0,
        }}
      >
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <span className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
            ({LETTER[k].toLowerCase()}) · {KIND_LABEL[p.kind]} ·{" "}
            {formatPoints(p.points)} pt{p.points > 1 ? "s" : ""}
          </span>
          {det && det.ok !== null && (
            <span className={`tag ${det.ok ? "tag-green" : "tag-red"}`}>
              {formatPoints(det.points)} / {formatPoints(det.max)}
              {det.ok ? " ✓" : ""}
            </span>
          )}
        </div>
        <div
          className="text-[14px] mb-2"
          style={{ color: "var(--ink)", whiteSpace: "pre-wrap" }}
        >
          {p.prompt}
        </div>
        {p.kind === "scq" && (
          <div className="flex flex-col gap-1.5">
            {p.options.map((o, i) => {
              const picked = given === i;
              const isCorrect = det && det.correct === i;
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
                  key={i}
                  onClick={() =>
                    !graded && setAnswers((a) => ({ ...a, [p.id]: i }))
                  }
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
                      borderRadius: 999,
                      border: `1.5px solid ${bd}`,
                      display: "grid",
                      placeItems: "center",
                      fontSize: 12,
                      fontWeight: 700,
                      color: "var(--ink-2)",
                    }}
                  >
                    {LETTER[i]}
                  </span>
                  <span
                    style={{ fontSize: 13.5, color: "var(--ink)", flex: 1 }}
                  >
                    {o}
                  </span>
                  {isCorrect && (
                    <span style={{ color: "var(--green-ink)", fontSize: 13 }}>
                      ✓
                    </span>
                  )}
                  {wrongPick && (
                    <span style={{ color: "var(--red-ink)" }}>✗</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        {p.kind === "code_output" && (
          <>
            <pre style={codeStyle}>{p.code}</pre>
            <label
              className="mb-1 block text-[12.5px]"
              style={{ color: "var(--ink-2)" }}
              htmlFor={`out-${p.id}`}
            >
              Sortie affichée
            </label>
            <textarea
              id={`out-${p.id}`}
              className="textarea w-full"
              rows={3}
              readOnly={!!graded}
              style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}
              value={typeof given === "string" ? given : ""}
              onChange={(e) =>
                setAnswers((a) => ({ ...a, [p.id]: e.target.value }))
              }
              placeholder="Ce que le code affiche, ligne pour ligne"
            />
            {det && !det.ok && (
              <div
                className="mt-2 text-[12.5px]"
                style={{ color: "var(--ink-2)" }}
              >
                <strong style={{ color: "var(--ink)" }}>Sortie exacte :</strong>
                <pre style={codeStyle}>{det.answer}</pre>
              </div>
            )}
          </>
        )}
        {p.kind === "short" && (
          <OpenResponse
            key={`${courseId}:${exam.id}:${p.id}`}
            questionId={p.id}
            statement={p.prompt}
            courseId={courseId}
            graded={!!graded}
            part={{ examId: exam.id, partId: p.id }}
            onChecked={(score) => setChecked((c) => ({ ...c, [p.id]: score }))}
            solution={
              det
                ? `<p>${escapeHtml(det.answer)}</p><p><strong>Barème</strong></p><ul>${det.criteria.map((c) => `<li>${escapeHtml(c.label)} (${c.points} pt${c.points > 1 ? "s" : ""})</li>`).join("")}</ul>`
                : null
            }
          />
        )}
        {det && det.explanation && (
          <p className="mt-2 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
            <strong style={{ color: "var(--ink)" }}>Pourquoi :</strong>{" "}
            {det.explanation}
          </p>
        )}
        <ReportButton
          courseId={courseId}
          examId={exam.id}
          kind="part"
          itemId={p.id}
        />
      </div>
    );
  };

  return (
    <ExamFrame
      id={exam.id}
      description={`${exam.blocks.length} question${exam.blocks.length > 1 ? "s" : ""} composée${exam.blocks.length > 1 ? "s" : ""} : un scénario, puis ses sous-questions. Le choix unique et la lecture de code se corrigent d’un coup ; une réponse courte se vérifie critère par critère.`}
      pdf={exam.pdf}
      solutions={exam.solutions}
      qs={qs}

    >
      {err && (
        <div
          role="alert"
          className="card card-pad mb-4"
          style={{ color: "var(--red)" }}
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
                {formatPoints(graded.score)} / {formatPoints(graded.total)}
              </div>
              <div className="stat-label">
                Choix unique et lecture de code
                {shortScore.total
                  ? ` · réponses courtes vérifiées : ${formatPoints(shortScore.earned)} / ${formatPoints(shortScore.total)}`
                  : ""}
                {graded.pending > shortScore.total
                  ? ` · ${formatPoints(graded.pending - shortScore.total)} pts de réponses courtes à vérifier ci-dessous`
                  : ""}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {exam.blocks.map((b, i) => (
          <section key={b.id} id={`block-${b.id}`} className="card card-pad">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
                Question {i + 1}
                {b.section ? ` · ${b.section}` : ""}
              </span>
              <span
                className="text-[12.5px] font-data"
                style={{ color: "var(--ink-2)" }}
              >
                {formatPoints(b.points)} pts
              </span>
            </div>
            <h2
              className="text-[16px] font-semibold mb-1"
              style={{ color: "var(--ink)" }}
            >
              {b.title}
            </h2>
            <Rich text={b.scenario} />
            {b.parts.map(renderPart)}
          </section>
        ))}
      </div>

      {!graded ? (
        <div
          id="exam-submit"
          className="mt-6 flex flex-wrap items-center gap-3"
        >
          <button
            className="btn btn-primary btn-lg"
            onClick={submit}
            disabled={busy || answered === 0}
          >
            {busy ? "Correction…" : "Corriger mon examen"}
          </button>
          <span className="text-[12.5px]" style={{ color: "var(--ink-3)" }}>
            {answered}/{autoParts.length} répondues (hors réponses courtes)
          </span>
        </div>
      ) : (
        <div id="exam-submit" className="mt-6">
          <a href={`/examens${qs}`} className="btn btn-ghost">
            ← retour aux examens
          </a>
        </div>
      )}
    </ExamFrame>
  );
}
