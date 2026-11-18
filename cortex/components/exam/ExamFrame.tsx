import { FileText } from "lucide-react";
import styles from "./exam.module.css";
import { useTranslations } from "use-intl/react";

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
  const t = useTranslations("examFrame");
  return (
    <div className={styles.exam}>
      <header className={styles.header}>
        <div>
          <h1>{t("title", { id })}</h1>
          <p className={styles.description}>{description}</p>
        </div>
        {pdf?.endsWith(".pdf") && (
          <div className={styles.documents}>
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
      <div className={styles.content}>{children}</div>
    </div>
  );
}
