import styles from "@/app/secondary.module.css";
import { PageHeader } from "@/components/ui/PageHeader";
import { CourseForm } from "@/components/cours/CourseForm";

export const metadata = { title: "Créer un cours · cortex" };

export default function NouveauCoursPage() {
  return (
    <div className={styles.page}>
      <PageHeader
        context={false}
        title="Créer un cours"
        description="Une matière, ses annales, et Cortex apprend à générer ses examens."
      />
      <div className={styles.courseGrid}>
        <CourseForm />
        <aside className={styles.guide}><div className={styles.eyebrow}>Pour commencer</div><h2>Prépare ton prochain final</h2><ol className={styles.steps}><li><span><strong>Identifie la matière</strong>Un nom et, si tu l’as, le code du cours.</span></li><li><span><strong>Réunis les supports</strong>Annales, slides et séries serviront à construire ton programme.</span></li><li><span><strong>Retrouve ton plan</strong>Tu pourras ensuite préparer le cours et commencer à t’entraîner.</span></li></ol></aside>
      </div>
    </div>
  );
}
