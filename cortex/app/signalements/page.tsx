"use client";

import { useEffect, useState } from "react";

type Report = { id: number; userId: string; course: string; examId: number; kind: string; reasonLabel: string; comment: string | null; stem: string; status: string; refundedCenti: number; createdAt: string };

const STATUS: Record<string, string> = { open: "à relire", confirmed: "erreur confirmée", not_confirmed: "non confirmé" };

/** Signalements de questions de tous les comptes — page du propriétaire (404 pour les autres). */
export default function ReportsPage() {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/reports").then(async (r) => {
      if (!r.ok) { setError(r.status === 404 ? "Page réservée au propriétaire de l'instance." : "Chargement impossible."); return; }
      setReports((await r.json()).reports);
    }).catch(() => setError("Chargement impossible."));
  }, []);
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-[20px] font-semibold" style={{ color: "var(--ink)" }}>Signalements de questions</h1>
      <p className="sub mt-1">Ce que les étudiants (ou leurs agents) ont relevé dans les examens générés : de quoi corriger le moteur.</p>
      {error && <p className="mt-6 text-[13px]" style={{ color: "var(--ink-3)" }}>{error}</p>}
      {reports && !reports.length && <p className="mt-6 text-[13px]" style={{ color: "var(--ink-3)" }}>Aucun signalement pour l&apos;instant.</p>}
      <div className="mt-6 flex flex-col gap-3">
        {reports?.map((r) => (
          <section key={r.id} className="card card-pad">
            <div className="text-[12px]" style={{ color: "var(--ink-3)" }}>
              #{r.id} · {r.createdAt} · {r.course} · examen {r.examId} ({r.kind}) · compte {r.userId.slice(0, 10)}… · <strong style={{ color: "var(--ink-2)" }}>{r.reasonLabel}</strong> · {STATUS[r.status] ?? r.status}{r.refundedCenti ? ` · ${r.refundedCenti / 100} crédit rendu` : ""}
            </div>
            <div className="mt-2 text-[13.5px]" style={{ color: "var(--ink)", whiteSpace: "pre-wrap" }}>{r.stem.slice(0, 600)}</div>
            {r.comment && <p className="mt-2 text-[12.5px]" style={{ color: "var(--ink-2)" }}>« {r.comment} »</p>}
          </section>
        ))}
      </div>
    </main>
  );
}
