"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { useTranslations } from "use-intl/react";
import { useFmt } from "@/lib/i18n/use-fmt";

type Report = { id: number; userId: string; course: string; examId: number; kind: string; reasonLabel: string; comment: string | null; stem: string; status: string; refundedCenti: number; createdAt: string };

const STATUS: Record<string, "statusOpen" | "statusConfirmed" | "statusNotConfirmed"> = {
  open: "statusOpen",
  confirmed: "statusConfirmed",
  not_confirmed: "statusNotConfirmed",
};

/** Signalements de questions de tous les comptes — page du propriétaire (404 pour les autres). */
export default function ReportsPage() {
  const t = useTranslations("reportsPage");
  const f = useFmt();
  const [reports, setReports] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/reports").then(async (r) => {
      if (!r.ok) { setError(r.status === 404 ? t("ownerOnly") : t("loadFailed")); return; }
      setReports((await r.json()).reports);
    }).catch(() => setError(t("loadFailed")));
  }, [t]);
  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader context={false} title={t("title")} description={t("description")} />
      {!reports && !error && <div className="skeleton mt-6 h-48 rounded-2xl" role="status" aria-label={t("loading")} />}
      {error && <p role="alert" className="mt-6 text-sm text-danger-hi">{error}</p>}
      {reports && !reports.length && <p className="mt-6 text-[13px]" style={{ color: "var(--ink-3)" }}>{t("empty")}</p>}
      <div className="mt-6 flex flex-col gap-3">
        {reports?.map((r) => (
          <section key={r.id} className="d2-card break-words p-5 sm:p-6">
            <div className="text-[12px]" style={{ color: "var(--ink-3)" }}>
              {t.rich("meta", {
                id: r.id,
                date: f.dateTime(r.createdAt),
                course: r.course,
                examId: r.examId,
                kind: r.kind,
                account: r.userId.slice(0, 10),
                reason: r.reasonLabel,
                status: STATUS[r.status] ? t(STATUS[r.status]) : r.status,
                refund: r.refundedCenti ? t("refund", { credits: r.refundedCenti / 100 }) : "none",
                strong: (chunks) => <strong style={{ color: "var(--ink-2)" }}>{chunks}</strong>,
              })}
            </div>
            {/* Signalements de tous les comptes : langue de l’énoncé inconnue ici, donc pas de lang. */}
            <div className="mt-2 text-[13.5px]" style={{ color: "var(--ink)", whiteSpace: "pre-wrap" }}>{r.stem.slice(0, 600)}</div>
            {r.comment && <p className="mt-2 text-[12.5px]" style={{ color: "var(--ink-2)" }}>{t("comment", { comment: r.comment })}</p>}
          </section>
        ))}
      </div>
    </div>
  );
}
