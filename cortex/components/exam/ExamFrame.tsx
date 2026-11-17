"use client";

import { FileText, Globe } from "lucide-react";
import { Segmented } from "@/components/ui/Segmented";
import { useExamOutput } from "@/lib/ux/exam-output";
import styles from "./exam.module.css";

const OUTPUTS = [
  { value: "site" as const, label: "Sur le site", Icon: Globe },
  { value: "pdf" as const, label: "PDF", Icon: FileText },
];

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
  const hasPdf = pdf?.endsWith(".pdf") ?? false;
  const [output, choose] = useExamOutput(true);
  const showPdf = hasPdf && output === "pdf";

  return (
    <div className={styles.exam}>
      <header className={styles.header}>
        <div>
          <h1>Examen blanc #{id}</h1>
          <p className={styles.description}>{description}</p>
        </div>
        {hasPdf && (
          <div className={styles.documents}>
            <Segmented label="Sortie de l’examen" options={OUTPUTS} value={output} onChange={choose} />
            <a href={`/exam/${pdf}${qs}`} target="_blank" rel="noopener">
              <FileText size={16} aria-hidden="true" />
              PDF énoncé
            </a>
            {solutions && (
              <a href={`/exam/${solutions}${qs}`} target="_blank" rel="noopener">
                <FileText size={16} aria-hidden="true" />
                PDF corrigé
              </a>
            )}
          </div>
        )}
      </header>
      {showPdf ? (
        <div className={styles.pdfView}>
          <iframe src={`/exam/${pdf}${qs}`} title={`Examen blanc #${id}, PDF`} className={styles.pdfFrame} />
          <p className={styles.pdfNote}>
            La mise en page de ton annale, relevée à la préparation du cours (une mise en page sobre si Cortex n’a pas pu la lire). Imprime-le, compose sur papier, puis reviens sur le site pour te corriger.
          </p>
        </div>
      ) : (
        <div className={styles.content}>{children}</div>
      )}
    </div>
  );
}
