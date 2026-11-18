import { PageHeader } from "@/components/ui/PageHeader";
import { SearchExperience } from "@/components/recherche/SearchExperience";
import { getT } from "@/lib/i18n/server";

export default async function RecherchePage() {
  const t = await getT("searchPage");
  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title={t("title")}
        description={t("description")}
      />
      <SearchExperience />
    </div>
  );
}
