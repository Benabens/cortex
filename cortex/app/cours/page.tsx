import { PageHeader } from "@/components/ui/PageHeader";
import { CourseList } from "@/components/cours/CourseList";
import { Button } from "@/components/ui/Button";

export const metadata = { title: "Mes cours — cortex" };

export default function CoursPage() {
  return (
    <div className="w-full max-w-[46rem]">
      <PageHeader
        context={false}
        title="Mes cours"
        description="Les matières de ton compte. Personne d’autre ne les voit."
      >
        <Button variant="primary" href="/cours/nouveau">
          + Ajouter un cours
        </Button>
      </PageHeader>
      <div className="mt-6">
        <CourseList />
      </div>
    </div>
  );
}
