import { PageHeader } from "@/components/ui/PageHeader";
import { CourseForm } from "@/components/cours/CourseForm";

export const metadata = { title: "Créer un cours — cortex" };

export default function NouveauCoursPage() {
  return (
    <div className="w-full max-w-[46rem]">
      <PageHeader
        context={false}
        title="Créer un cours"
        description="Une matière, ses annales, et Cortex apprend à générer ses examens."
      />
      <div className="mt-6">
        <CourseForm />
      </div>
    </div>
  );
}
