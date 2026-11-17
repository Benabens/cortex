"use client";

import styles from "@/app/secondary.module.css";
import { PageHeader } from "@/components/ui/PageHeader";
import { TrainingStudio } from "@/components/entrainement/TrainingStudio";
import { LabsSeries } from "@/components/entrainement/LabsSeries";
import { useCourse } from "@/lib/ux/api";
import { useTranslations } from "use-intl/react";

export default function EntrainementPage() {
  const t = useTranslations("trainingPage");
  const { courseId } = useCourse();

  return (
    <div className={styles.page}>
      <PageHeader title={t("title")} description={t("description")} />
      <TrainingStudio key={courseId} />
      {/* La série Labs est propre à CS-202 (moule Q6 2025 sur le code des labs). */}
      {courseId === "cs-202" && <LabsSeries />}
    </div>
  );
}
