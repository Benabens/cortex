"use client";

import { useId, useState } from "react";
import { useTranslations } from "use-intl/react";

const REASONS = [
  { id: "wrong_answer", labelKey: "reasonWrong" },
  {
    id: "off_course",
    labelKey: "reasonOffCourse",
  },
  { id: "duplicate", labelKey: "reasonDuplicate" },
  { id: "ambiguous", labelKey: "reasonAmbiguous" },
] as const;

/**
 * « Signaler » sous une question (boucle de relecture, lib/question-reports) :
 * discret tant qu'il est fermé ; un motif, un commentaire libre, et le verdict
 * (re-vérification d'une « réponse fausse », remboursement éventuel) en retour.
 */
export function ReportButton({
  courseId,
  examId,
  kind,
  itemId,
}: {
  courseId: string;
  examId: number;
  kind: "qcm" | "open" | "part";
  itemId: number;
}) {
  const t = useTranslations("reportButton");
  const commentId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("");
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (done)
    return (
      <p
        role="status"
        className="mt-2 text-[12px]"
        style={{ color: "var(--ink-3)" }}
      >
        {done}
      </p>
    );
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex min-h-11 items-center text-[12px]"
        style={{
          color: "var(--ink-3)",
          background: "none",
          border: 0,
          padding: 0,
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        {t("report")}
      </button>
    );
  }
  const send = async () => {
    if (!reason || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/questions/report?course=${encodeURIComponent(courseId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ examId, kind, itemId, reason, comment }),
        },
      );
      const d = await res.json();
      if (!res.ok) {
        setError(d.error ?? t("failed"));
        return;
      }
      const refund =
        d.refundedCenti > 0
          ? t("refund", { credits: d.refundedCenti / 100 })
          : "";
      const verdict =
        d.status === "confirmed"
          ? t("confirmed")
          : d.status === "not_confirmed"
            ? t("notConfirmed")
            : "";
      setDone(
        [t("thanks"), verdict, refund].filter(Boolean).join(" "),
      );
    } catch {
      setError(t("failedRetry"));
    } finally {
      setSending(false);
    }
  };
  return (
    <div
      className="mt-3 inset"
      style={{ padding: "10px 12px", border: "1px solid var(--line)" }}
    >
      <div className="flex flex-col gap-1.5">
        {REASONS.map((r) => (
          <label
            key={r.id}
            className="min-h-11 text-[12.5px]"
            style={{
              color: "var(--ink-2)",
              display: "flex",
              gap: 8,
              alignItems: "center",
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name={`report-${kind}-${itemId}`}
              value={r.id}
              checked={reason === r.id}
              onChange={() => setReason(r.id)}
            />
            {t(r.labelKey)}
          </label>
        ))}
      </div>
      <label htmlFor={commentId} className="mt-3 block text-sm text-ink-2">
        {t("details")}
      </label>
      <textarea
        id={commentId}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={1000}
        rows={2}
        placeholder={t("placeholder")}
        className="mt-2 w-full text-[12.5px]"
        style={{
          background: "var(--surface-inset)",
          color: "var(--ink)",
          border: "1px solid var(--line)",
          borderRadius: 6,
          padding: "6px 8px",
        }}
      />
      {error && (
        <p
          role="alert"
          className="mt-1 text-[12px]"
          style={{ color: "var(--red-ink)" }}
        >
          {error}
        </p>
      )}
      <div className="mt-2 flex gap-3">
        <button
          type="button"
          onClick={send}
          disabled={!reason || sending}
          className="min-h-11 text-[12.5px]"
          style={{
            color: reason ? "var(--accent-ink)" : "var(--ink-3)",
            background: "none",
            border: 0,
            padding: 0,
            cursor: reason ? "pointer" : "default",
            fontWeight: 600,
          }}
        >
          {sending ? t("sending") : t("send")}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="min-h-11 text-[12.5px]"
          style={{
            color: "var(--ink-3)",
            background: "none",
            border: 0,
            padding: 0,
            cursor: "pointer",
          }}
        >
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}
