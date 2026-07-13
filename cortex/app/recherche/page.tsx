import { PageHeader } from "@/components/ui/PageHeader";
import { SearchExperience } from "@/components/recherche/SearchExperience";

export default function RecherchePage() {
  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title="Recherche"
        description="Tout ton corpus — cours, séries, finals, cheat sheets, code — en un clin d’œil."
      />
      <SearchExperience />
    </div>
  );
}
