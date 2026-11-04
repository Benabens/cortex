import { FileText } from "lucide-react";
import styles from "./exam.module.css";

/** Présentation D2 de l’examen existant, sans ajouter de parcours ni de bilan. */
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
  return (
    <div className={styles.exam}>
      <header className={styles.header}>
        <div>
          <h1>Examen blanc #{id}</h1>
          <p className={styles.description}>{description}</p>
        </div>
        {pdf?.endsWith(".pdf") && (
          <div className={styles.documents}>
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
      <div className={styles.content}>{children}</div>
    </div>
  );
}
