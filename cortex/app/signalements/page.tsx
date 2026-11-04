"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";

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
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader context={false} title="Signalements de questions" description="Ce que les étudiants (ou leurs agents) ont relevé dans les examens générés : de quoi corriger le moteur." />
      {!reports && !error && <div className="skeleton mt-6 h-48 rounded-2xl" aria-label="Chargement des signalements" />}
      {error && <p role="alert" className="mt-6 text-sm text-danger-hi">{error}</p>}
      {reports && !reports.length && <p className="mt-6 text-[13px]" style={{ color: "var(--ink-3)" }}>Aucun signalement pour l&apos;instant.</p>}
      <div className="mt-6 flex flex-col gap-3">
        {reports?.map((r) => (
          <section key={r.id} className="d2-card break-words p-5 sm:p-6">
            <div className="text-[12px]" style={{ color: "var(--ink-3)" }}>
              #{r.id} · {r.createdAt} · {r.course} · examen {r.examId} ({r.kind}) · compte {r.userId.slice(0, 10)}… · <strong style={{ color: "var(--ink-2)" }}>{r.reasonLabel}</strong> · {STATUS[r.status] ?? r.status}{r.refundedCenti ? ` · ${r.refundedCenti / 100} crédit rendu` : ""}
            </div>
            <div className="mt-2 text-[13.5px]" style={{ color: "var(--ink)", whiteSpace: "pre-wrap" }}>{r.stem.slice(0, 600)}</div>
            {r.comment && <p className="mt-2 text-[12.5px]" style={{ color: "var(--ink-2)" }}>« {r.comment} »</p>}
          </section>
        ))}
      </div>
    </div>
  );
}
