import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Check, LockKeyhole } from "lucide-react";
import { freeToolEnabled, freeToolLimits } from "@/lib/exam-topics/config";
import { getLocale, getT } from "@/lib/i18n/server";
import { DEFAULT_LANDING_URL, landingOrigin } from "@/lib/legal";
import { publicOrigin } from "@/lib/public-url";
import { INDEXABLE } from "@/lib/seo";
import { ToolHeader } from "./ToolHeader";
import { UploadForm } from "./UploadForm";

export const dynamic = "force-dynamic";

const PATH = "/whats-on-my-exam";

/** Page publique et indexable de l'outil gratuit (cf. lib/seo, app/robots.ts) ; une adresse par langue. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getT("examTopics");
  const locale = await getLocale();
  const origin = publicOrigin();
  const title = t("metaTitle");
  const description = t("metaDescription");
  return {
    ...INDEXABLE,
    title,
    description,
    metadataBase: origin ? new URL(origin) : undefined,
    alternates: {
      canonical: locale === "fr" ? `${PATH}?lang=fr` : PATH,
      languages: { en: PATH, fr: `${PATH}?lang=fr`, "x-default": PATH },
    },
    openGraph: {
      type: "website",
      // i18n-allow: nom de marque
      siteName: "Cortex",
      locale: locale === "fr" ? "fr_FR" : "en_GB",
      title,
      description,
      url: locale === "fr" ? `${PATH}?lang=fr` : PATH,
    },
    twitter: { card: "summary", title, description },
  };
}

export default async function ExamTopicsPage() {
  if (!freeToolEnabled()) notFound();
  const t = await getT("examTopics");
  const locale = await getLocale();
  const limits = freeToolLimits();
  const maxMb = Math.round(limits.maxFileBytes / 1024 / 1024);
  return (
    <div style={{ background: "var(--bare-bg)", color: "var(--bare-ink)" }} className="min-h-dvh">
      <ToolHeader locale={locale} home={landingOrigin() ?? DEFAULT_LANDING_URL} />
      <main className="mx-auto grid w-full max-w-6xl gap-10 px-4 pb-20 pt-6 sm:px-6 md:grid-cols-[1.05fr_1fr] md:items-start md:gap-14 md:pt-14">
        <section className="max-w-[34rem]">
          <h1 className="text-[2.1rem] font-semibold leading-[1.08] tracking-tight sm:text-[2.7rem]">{t("title")}</h1>
          <p className="mt-4 max-w-[46ch] text-[1.02rem] leading-relaxed" style={{ color: "var(--bare-muted)" }}>
            {t("subtitle", { maxFiles: limits.maxFiles })}
          </p>
          <h2 className="mt-10 text-[0.95rem] font-semibold">{t("getTitle")}</h2>
          <ul className="mt-4 flex flex-col gap-3.5">
            {(["get1", "get2", "get3"] as const).map((k) => (
              <li key={k} className="flex gap-3 text-[0.92rem] leading-relaxed" style={{ color: "var(--bare-muted)" }}>
                <Check aria-hidden className="mt-1 size-4 shrink-0 text-accent-hi" strokeWidth={2} />
                <span>{t(k)}</span>
              </li>
            ))}
          </ul>
        </section>

        <div className="flex flex-col gap-5">
          <UploadForm limits={{ maxFiles: limits.maxFiles, maxFileBytes: limits.maxFileBytes, maxMb, maxPages: limits.maxPagesPerFile }} />
          <section className="px-1">
            <h2 className="flex items-center gap-2 text-[0.85rem] font-semibold">
              <LockKeyhole aria-hidden className="size-4 text-accent-hi" strokeWidth={2} />
              {t("privacyTitle")}
            </h2>
            <ul className="mt-2.5 flex list-disc flex-col gap-1.5 pl-5 text-[0.84rem] leading-relaxed" style={{ color: "var(--bare-muted)" }}>
              <li>{t("privacy1")}</li>
              <li>{t("privacy2")}</li>
              <li>{t("privacy3")}</li>
              <li>{t("privacy4")}</li>
            </ul>
            <a
              href={`${landingOrigin() ?? DEFAULT_LANDING_URL}${locale === "fr" ? "/privacy" : "/privacy-en"}`}
              className="mt-2.5 inline-block pl-5 text-[0.84rem] font-medium text-accent-hi underline decoration-[var(--color-underline-hi)] underline-offset-4 hover:decoration-current"
            >
              {t("privacyLink")}
            </a>
          </section>
        </div>
      </main>
    </div>
  );
}
