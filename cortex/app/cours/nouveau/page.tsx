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
      <div className="w-full max-w-4xl">
        <CourseForm />
      </div>
    </div>
  );
}
