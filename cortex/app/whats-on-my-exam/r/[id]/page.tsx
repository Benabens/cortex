import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { contactEmail } from "@/lib/contact";
import { freeToolEnabled } from "@/lib/exam-topics/config";
import type { ExamTopic, ExamTopicsResult } from "@/lib/exam-topics/result";
import { getRun } from "@/lib/exam-topics/runs";
import { getLocale, getT } from "@/lib/i18n/server";
import { DEFAULT_LANDING_URL, landingOrigin } from "@/lib/legal";
import { publicOrigin } from "@/lib/public-url";
import { NOINDEX } from "@/lib/seo";
import { ToolHeader } from "../../ToolHeader";
import { CopyLink } from "./CopyLink";
import { RunPoller } from "./RunPoller";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Résultat partageable : jamais indexé (le lien circule, la page ne se cherche pas). */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = await getT("examTopics");
  const run = await getRun((await params).id);
  const subject = run?.status === "done" ? run.result.subject : null;
  const title = subject ? t("resultMetaTitle", { subject }) : t("resultMetaTitleNoSubject");
  const origin = publicOrigin();
  return {
    ...NOINDEX,
    title,
    description: t("resultMetaDescription"),
    metadataBase: origin ? new URL(origin) : undefined,
    // i18n-allow: nom de marque
    openGraph: { type: "article", siteName: "Cortex", title, description: t("resultMetaDescription") },
    twitter: { card: "summary", title, description: t("resultMetaDescription") },
  };
}

export default async function ExamTopicsResultPage({ params }: Params) {
  const { id } = await params;
  if (!freeToolEnabled()) notFound();
  const run = await getRun(id);
  if (!run) notFound();
  const t = await getT("examTopics");
  const locale = await getLocale();
  return (
    <div style={{ background: "var(--bare-bg)", color: "var(--bare-ink)" }} className="min-h-dvh">
      <ToolHeader locale={locale} home={landingOrigin() ?? DEFAULT_LANDING_URL} />
      <main className="mx-auto w-full max-w-4xl px-4 pb-20 pt-4 sm:px-6 md:pt-10">
        {run.status === "running" && (
          <section aria-live="polite" className="d2-card px-5 py-10 text-center sm:px-10">
            <RunPoller id={id} />
            <h1 className="mt-5 text-[1.5rem] font-semibold tracking-tight">{t("runningTitle")}</h1>
            <p className="mx-auto mt-2 max-w-[44ch] text-[0.92rem] leading-relaxed" style={{ color: "var(--bare-muted)" }}>{t("runningBody")}</p>
          </section>
        )}
        {run.status === "failed" && <Failure code={run.error} t={t} />}
        {run.status === "done" && <Result result={run.result} t={t} locale={locale} />}
      </main>
    </div>
  );
}

type T = Awaited<ReturnType<typeof getT<"examTopics">>>;

const FAILURES = ["unreadable", "no_questions", "budget", "llm", "interrupted", "internal"] as const;

function Failure({ code, t }: { code: string; t: T }) {
  const c = (FAILURES as readonly string[]).includes(code) ? (code as (typeof FAILURES)[number]) : "internal";
  return (
    <section role="alert" className="d2-card px-5 py-10 text-center sm:px-10">
      <h1 className="text-[1.5rem] font-semibold tracking-tight">{t(`failed_${c}`)}</h1>
      <p className="mx-auto mt-2 max-w-[48ch] text-[0.92rem] leading-relaxed" style={{ color: "var(--bare-muted)" }}>
        {t(`failed_${c}_body`, { contact: contactEmail() })}
      </p>
      <a href="/whats-on-my-exam" className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-accent px-6 text-[0.9rem] font-semibold text-white transition-colors duration-150 hover:bg-accent-deep">
        {t("again")}
      </a>
    </section>
  );
}

function Result({ result, t, locale }: { result: ExamTopicsResult; t: T; locale: string }) {
  const top = Math.max(...result.topics.map((x) => x.sharePct), 1);
  const pct = (n: number) => n.toLocaleString(locale === "fr" ? "fr-FR" : "en-GB", { maximumFractionDigits: 1 });
  return (
    <>
      <section className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[1.9rem] font-semibold leading-[1.1] tracking-tight sm:text-[2.3rem]">
            {result.subject ? t("heading", { subject: result.subject }) : t("headingNoSubject")}
          </h1>
          <p className="mt-2 text-[0.95rem]" style={{ color: "var(--bare-muted)" }}>
            {t("summary", { questions: result.questions, papers: result.papers })}
          </p>
        </div>
        <CopyLink />
      </section>

      <ol className="mt-8 flex flex-col gap-3">
        {result.topics.map((topic, i) => (
          <TopicRow key={`${i}-${topic.label}`} rank={i + 1} topic={topic} total={result.papers} widthPct={(topic.sharePct / top) * 100} t={t} pct={pct} />
        ))}
      </ol>

      <p className="mt-5 text-[0.8rem] leading-relaxed" style={{ color: "var(--bare-faint)" }}>
        {t("disclaimer")} {t("shareNote")}
      </p>

      <section className="d2-hero mt-12 grid gap-6 p-6 sm:p-9 md:grid-cols-[1.2fr_1fr] md:items-center">
        <div>
          <h2 className="text-[1.45rem] font-semibold tracking-tight">{t("ctaTitle")}</h2>
          <p className="mt-2 max-w-[48ch] text-[0.93rem] leading-relaxed" style={{ color: "var(--color-on-hero-2)" }}>{t("ctaBody")}</p>
          <a
            href="/login"
            className="mt-6 inline-flex h-12 items-center gap-2 rounded-full px-6 text-[0.95rem] font-semibold transition-colors duration-150"
            style={{ background: "var(--color-hero-btn)", color: "var(--color-on-hero-btn)" }}
          >
            {t("ctaButton")}
            <ArrowRight aria-hidden className="size-4" strokeWidth={2} />
          </a>
        </div>
        <ul className="flex flex-col gap-3 text-[0.9rem]">
          {(["cta1", "cta2", "cta3"] as const).map((k) => (
            <li key={k} className="flex gap-3">
              <Check aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={2.25} />
              <span>{t(k)}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-8 text-center">
        <a href="/whats-on-my-exam" className="text-[0.88rem] font-medium text-accent-hi underline decoration-[var(--color-underline-hi)] underline-offset-4 hover:decoration-current">
          {t("again")}
        </a>
      </p>
    </>
  );
}

function TopicRow({ rank, topic, total, widthPct, t, pct }: { rank: number; topic: ExamTopic; total: number; widthPct: number; t: T; pct: (n: number) => string }) {
  return (
    <li className="d2-card p-4 sm:p-5">
      <div className="flex items-start gap-4">
        <span className="mt-0.5 w-6 shrink-0 text-right text-[0.9rem] font-semibold tabular-nums" style={{ color: "var(--bare-faint)" }}>{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
            <h2 className="text-[1.02rem] font-semibold leading-snug">{topic.label}</h2>
            <p className="shrink-0 text-[0.84rem] tabular-nums" style={{ color: "var(--bare-muted)" }}>
              <span className="font-semibold" style={{ color: "var(--bare-ink)" }}>{t("share", { pct: pct(topic.sharePct) })}</span>
              {topic.pointsPct !== null && <span> · {t("points", { pct: pct(topic.pointsPct) })}</span>}
            </p>
          </div>
          {/* Part relative au sujet le plus fréquent, sans piste de fond. */}
          <div aria-hidden className="mt-2.5 h-1 rounded-full bg-accent" style={{ width: `${Math.max(4, widthPct)}%` }} />
          <p className="mt-2.5 text-[0.8rem]" style={{ color: "var(--bare-faint)" }}>
            {t("occurrences", { n: topic.occurrences })}
            {total > 1 && <> · {t("papers", { n: topic.papers, total })}</>}
          </p>
          <dl className="mt-3 grid gap-x-6 gap-y-2.5 text-[0.86rem] leading-relaxed sm:grid-cols-[9.5rem_1fr]">
            {topic.forms.length > 0 && (<>
              <dt className="font-medium" style={{ color: "var(--bare-faint)" }}>{t("forms")}</dt>
              <dd className="flex flex-wrap gap-1.5">
                {topic.forms.map((f) => (
                  <span key={f} className="rounded-full px-2.5 py-0.5 text-[0.8rem]" style={{ background: "var(--bare-surface-hover)", border: "1px solid var(--bare-line)" }}>{f}</span>
                ))}
              </dd>
            </>)}
            {topic.method && (<>
              <dt className="font-medium" style={{ color: "var(--bare-faint)" }}>{t("method")}</dt>
              <dd style={{ color: "var(--bare-muted)" }}>{topic.method}</dd>
            </>)}
            {topic.example && (<>
              <dt className="font-medium" style={{ color: "var(--bare-faint)" }}>{t("example")}</dt>
              <dd style={{ color: "var(--bare-muted)" }}>{topic.example}</dd>
            </>)}
            {topic.trap && (<>
              <dt className="font-medium" style={{ color: "var(--bare-faint)" }}>{t("trap")}</dt>
              <dd style={{ color: "var(--bare-muted)" }}>{topic.trap}</dd>
            </>)}
          </dl>
        </div>
      </div>
    </li>
  );
}
