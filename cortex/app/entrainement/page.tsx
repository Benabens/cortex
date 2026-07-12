"use client";

import { PageHeader } from "@/components/ui/PageHeader";
import { TrainingStudio } from "@/components/entrainement/TrainingStudio";
import { LabsSeries } from "@/components/entrainement/LabsSeries";
import { useCourse } from "@/lib/ux/api";

export default function EntrainementPage() {
  const { courseId } = useCourse();

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title="Entraînement"
        description="Drille et fais-toi corriger : exo ciblé au format examen, indices progressifs, ou exo sur mesure."
      />
      <TrainingStudio key={courseId} />
      {/* La série Labs est propre à CS-202 (moule Q6 2025 sur le code des labs). */}
      {courseId === "cs-202" && <LabsSeries />}
    </div>
  );
}
