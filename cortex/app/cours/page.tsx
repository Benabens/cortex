import styles from "@/app/secondary.module.css";
import { PageHeader } from "@/components/ui/PageHeader";
import { CourseList } from "@/components/cours/CourseList";
import { Button } from "@/components/ui/Button";
import { getT } from "@/lib/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("courses");
  return { title: t("metaTitle") };
}

export default async function CoursPage() {
  const t = await getT("courses");
  return (
    <div className={styles.page}>
      <PageHeader
        context={false}
        title={t("title")}
        description={t("description")}
      >
        <Button variant="primary" href="/cours/nouveau">
          {t("add")}
        </Button>
      </PageHeader>
      <div className="w-full max-w-4xl">
        <CourseList />
      </div>
    </div>
  );
}
