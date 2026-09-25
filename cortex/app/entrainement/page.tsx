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
        description="Un exo au format du final à partir d’un concept, d’une consigne ou d’une image — avec des indices progressifs à révéler si tu bloques."
      />
      <TrainingStudio key={courseId} />
      {/* La série Labs est propre à CS-202 (moule Q6 2025 sur le code des labs). */}
      {courseId === "cs-202" && <LabsSeries />}
    </div>
  );
}
