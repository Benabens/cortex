import { Wordmark } from "@/components/shell/Logo";
import { LOCALES, LOCALE_NAMES, type Locale } from "@/lib/i18n/locale";
import { getT } from "@/lib/i18n/server";

/**
 * Bandeau des pages de l'outil gratuit : marque, et la langue en liens `?lang=` (pas le
 * sélecteur de l'app) : chaque version a son adresse, lisible par un moteur sans cookie.
 */
export async function ToolHeader({ locale, home }: { locale: Locale; home: string }) {
  const t = await getT("locale");
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-5 sm:px-6">
      <a href={home} className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-hi">
        <Wordmark markSize={26} textSize="1.2rem" />
      </a>
      <nav aria-label={t("label")} className="flex items-center gap-1 text-[0.82rem]">
        {LOCALES.map((l) => (
          <a
            key={l}
            href={`?lang=${l}`}
            hrefLang={l}
            lang={l}
            aria-current={l === locale ? "true" : undefined}
            className="rounded-full px-3 py-1.5 transition-colors duration-150 aria-[current]:bg-[var(--bare-surface)] aria-[current]:font-semibold"
            style={{ color: l === locale ? "var(--bare-ink)" : "var(--bare-muted)" }}
          >
            {LOCALE_NAMES[l]}
          </a>
        ))}
      </nav>
    </header>
  );
}
