import styles from "@/app/secondary.module.css";
import { PageHeader } from "@/components/ui/PageHeader";
import { CourseList } from "@/components/cours/CourseList";
import { Button } from "@/components/ui/Button";

export const metadata = { title: "Mes cours · cortex" };

export default function CoursPage() {
  return (
    <div className={styles.page}>
      <PageHeader
        context={false}
        title="Mes cours"
        description="Les matières de ton compte. Personne d’autre ne les voit."
      >
        <Button variant="primary" href="/cours/nouveau">
          + Ajouter un cours
        </Button>
      </PageHeader>
      <div className={styles.courseGrid}>
        <CourseList />
        <aside className={styles.guide}><h2>Un plan par matière</h2><p className="mt-3">Chaque cours garde ses sources, ses exercices et ta progression.</p><ol className={styles.steps}><li><span><strong>Choisis ton cours</strong>Retrouve le programme et ta séance du jour.</span></li><li><span><strong>Ajoute tes supports</strong>Les annales donnent le format de ton final.</span></li><li><span><strong>Avance à ton rythme</strong>Les révisions suivent ton travail dans chaque matière.</span></li></ol></aside>
      </div>
    </div>
  );
}
