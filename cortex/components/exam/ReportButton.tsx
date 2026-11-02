"use client";

import { useState } from "react";

const REASONS = [
  { id: "wrong_answer", label: "Réponse fausse" },
  { id: "off_course", label: "Hors programme / définition différente du cours" },
  { id: "duplicate", label: "Doublon" },
  { id: "ambiguous", label: "Énoncé ambigu" },
] as const;

/**
 * « Signaler » sous une question (boucle de relecture, lib/question-reports) :
 * discret tant qu'il est fermé ; un motif, un commentaire libre, et le verdict
 * (re-vérification d'une « réponse fausse », remboursement éventuel) en retour.
 */
export function ReportButton({ courseId, examId, kind, itemId }: { courseId: string; examId: number; kind: "qcm" | "open" | "part"; itemId: number }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("");
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (done) return <p className="mt-2 text-[12px]" style={{ color: "var(--ink-3)" }}>{done}</p>;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-2 text-[12px]" style={{ color: "var(--ink-3)", background: "none", border: 0, padding: 0, cursor: "pointer", textDecoration: "underline" }}>
        Signaler
      </button>
    );
  }
  const send = async () => {
    if (!reason || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/questions/report?course=${encodeURIComponent(courseId)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ examId, kind, itemId, reason, comment }),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error ?? "Signalement impossible."); return; }
      const refund = d.refundedCenti > 0 ? ` ${(d.refundedCenti / 100).toLocaleString("fr-CH")} crédit rendu.` : "";
      const verdict = d.status === "confirmed" ? " Erreur confirmée à la re-vérification." : d.status === "not_confirmed" ? " La re-vérification ne trouve pas d'erreur : le signalement est gardé pour relecture." : "";
      setDone(`Merci, c'est noté : la question sort de tes révisions et sert de contre-exemple aux prochains examens de ce cours.${verdict}${refund}`);
    } catch {
      setError("Signalement impossible. Réessaie dans un instant.");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="mt-3 inset" style={{ padding: "10px 12px", border: "1px solid var(--line)" }}>
      <div className="flex flex-col gap-1.5">
        {REASONS.map((r) => (
          <label key={r.id} className="text-[12.5px]" style={{ color: "var(--ink-2)", display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input type="radio" name={`report-${kind}-${itemId}`} value={r.id} checked={reason === r.id} onChange={() => setReason(r.id)} />
            {r.label}
          </label>
        ))}
      </div>
      <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} rows={2} placeholder="Ce qui ne va pas (facultatif)" className="mt-2 w-full text-[12.5px]" style={{ background: "var(--surface-inset)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px" }} />
      {error && <p className="mt-1 text-[12px]" style={{ color: "var(--red-ink)" }}>{error}</p>}
      <div className="mt-2 flex gap-3">
        <button type="button" onClick={send} disabled={!reason || sending} className="text-[12.5px]" style={{ color: reason ? "var(--accent-ink)" : "var(--ink-3)", background: "none", border: 0, padding: 0, cursor: reason ? "pointer" : "default", fontWeight: 600 }}>
          {sending ? "Envoi…" : "Envoyer"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-[12.5px]" style={{ color: "var(--ink-3)", background: "none", border: 0, padding: 0, cursor: "pointer" }}>Annuler</button>
      </div>
    </div>
  );
}
