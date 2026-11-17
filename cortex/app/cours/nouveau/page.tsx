import styles from "@/app/secondary.module.css";
import { PageHeader } from "@/components/ui/PageHeader";
import { CourseForm } from "@/components/cours/CourseForm";
import { getT } from "@/lib/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("courses");
  return { title: t("newMetaTitle") };
}

export default async function NouveauCoursPage() {
  const t = await getT("courses");
  return (
    <div className={styles.page}>
      <PageHeader
        context={false}
        title={t("newTitle")}
        description={t("newDescription")}
      />
      <div className="w-full max-w-4xl">
        <CourseForm />
      </div>
    </div>
  );
}
