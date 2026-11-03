import Link from "next/link";
import { ArrowLeft, FileText, ArrowDown } from "lucide-react";
import styles from "./exam.module.css";

type QuestionLink = { id: string; label: string; answered: boolean };

export function ExamFrame({
  id,
  description,
  pdf,
  solutions,
  qs,
  questions,
  graded,
  children,
}: {
  id: number;
  description: string;
  pdf: string | null;
  solutions?: string | null;
  qs: string;
  questions: QuestionLink[];
  graded: boolean;
  children: React.ReactNode;
}) {
  const answered = questions.filter((question) => question.answered).length;
  return (
    <div className={styles.exam}>
      <Link href={`/examens${qs}`} className={styles.back}>
        <ArrowLeft size={16} aria-hidden="true" />
        Mes examens blancs
      </Link>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>
            {graded ? "Ton bilan" : "À ton rythme"}
          </p>
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
              <a
                href={`/exam/${solutions}${qs}`}
                target="_blank"
                rel="noopener"
              >
                <FileText size={16} aria-hidden="true" />
                PDF corrigé
              </a>
            )}
          </div>
        )}
      </header>
      <div className={styles.layout}>
        <aside className={styles.outline} aria-label="Navigation dans l’examen">
          <div className={styles.outlineTitle}>
            <h2>{graded ? "Revoir la correction" : "Ton avancement"}</h2>
            <span>
              {answered}/{questions.length}
            </span>
          </div>
          <progress
            max={Math.max(1, questions.length)}
            value={answered}
            aria-label="Questions renseignées"
          />
          <nav aria-label="Questions" className={styles.questionLinks}>
            {questions.map((question, index) => (
              <a
                key={question.id}
                href={`#${question.id}`}
                data-answered={question.answered}
                aria-label={`${question.label}${question.answered ? ", renseignée" : ", à compléter"}`}
              >
                {index + 1}
              </a>
            ))}
          </nav>
          <p>
            {graded
              ? "Les réponses et explications sont affichées sous chaque question."
              : "Tu peux revenir à chaque question avant de demander la correction."}
          </p>
          <a href="#exam-submit" className={styles.jump}>
            <ArrowDown size={16} aria-hidden="true" />
            {graded ? "Retour aux examens" : "Aller à la correction"}
          </a>
        </aside>
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
