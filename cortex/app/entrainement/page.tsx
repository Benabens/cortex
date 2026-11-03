"use client";

import styles from "@/app/secondary.module.css";
import { TrainingNav } from "@/components/entrainement/TrainingNav";
import { PageHeader } from "@/components/ui/PageHeader";
import { TrainingStudio } from "@/components/entrainement/TrainingStudio";
import { LabsSeries } from "@/components/entrainement/LabsSeries";
import { useCourse } from "@/lib/ux/api";

export default function EntrainementPage() {
  const { courseId } = useCourse();

  return (
    <div className={styles.page}>
      <PageHeader title="Entraînement" description="Crée un exercice sur une notion, une consigne ou une image." />
      <TrainingNav current="/entrainement" />
      <TrainingStudio key={courseId} />
      {/* La série Labs est propre à CS-202 (moule Q6 2025 sur le code des labs). */}
      {courseId === "cs-202" && <LabsSeries />}
    </div>
  );
}
