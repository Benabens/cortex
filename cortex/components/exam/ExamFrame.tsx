"use client";

import { FileText } from "lucide-react";
import { Segmented } from "@/components/ui/Segmented";
import { examOutputOptions, useExamOutput } from "@/lib/ux/exam-output";
import styles from "./exam.module.css";
import { useTranslations } from "use-intl/react";

/**
 * Présentation D2 de l’examen existant, sans ajouter de parcours ni de bilan. Avec un PDF, la
 * sortie se choisit ici : les questions sur le site, ou le PDF à la mise en page de l’annale
 * (le même examen, déjà compilé : rien à payer de plus).
 */
export function ExamFrame({
  id,
  description,
  pdf,
  solutions,
  qs,
  children,
}: {
  id: number;
  description: string;
  pdf: string | null;
  solutions?: string | null;
  qs: string;
  children: React.ReactNode;
}) {
  const t = useTranslations("examFrame");
  const to = useTranslations("examOutput");
  const hasPdf = pdf?.endsWith(".pdf") ?? false;
  const [output, choose] = useExamOutput(true);
  const showPdf = hasPdf && output === "pdf";

  return (
    <div className={styles.exam}>
      <header className={styles.header}>
        <div>
          <h1>{t("title", { id })}</h1>
          <p className={styles.description}>{description}</p>
        </div>
        {hasPdf && (
          <div className={styles.documents}>
            <Segmented label={to("label")} options={examOutputOptions({ site: to("site"), pdf: to("pdf") })} value={output} onChange={choose} />
            <a href={`/exam/${pdf}${qs}`} target="_blank" rel="noopener">
              <FileText size={16} aria-hidden="true" />
              {t("questionPdf")}
            </a>
            {solutions && (
              <a href={`/exam/${solutions}${qs}`} target="_blank" rel="noopener">
                <FileText size={16} aria-hidden="true" />
                {t("solutionPdf")}
              </a>
            )}
          </div>
        )}
      </header>
      {showPdf ? (
        <div className={styles.pdfView}>
          <iframe src={`/exam/${pdf}${qs}`} title={to("frameTitle", { id })} className={styles.pdfFrame} />
          <p className={styles.pdfNote}>
            {to("pdfNote")}
          </p>
        </div>
      ) : (
        <div className={styles.content}>{children}</div>
      )}
    </div>
  );
}
