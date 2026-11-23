"use client";

import { useState } from "react";
import { Check, Link2 } from "lucide-react";
import { useTranslations } from "use-intl/react";

/** Copie l'adresse du résultat, sans `?lang=` : chacun le lit dans sa langue. */
export function CopyLink() {
  const t = useTranslations("examTopics");
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        const url = `${window.location.origin}${window.location.pathname}`;
        await navigator.clipboard?.writeText(url).then(() => setCopied(true), () => setCopied(false));
        setTimeout(() => setCopied(false), 2500);
      }}
      className="inline-flex h-10 shrink-0 items-center gap-2 self-start rounded-full border px-4 text-[0.86rem] font-medium transition-colors duration-150 hover:bg-[var(--bare-surface-hover)] sm:self-auto"
      style={{ borderColor: "var(--bare-field-line)", background: "var(--bare-surface)", color: "var(--bare-ink)" }}
    >
      {copied ? <Check aria-hidden className="size-4" strokeWidth={2} /> : <Link2 aria-hidden className="size-4" strokeWidth={2} />}
      <span aria-live="polite">{copied ? t("copied") : t("copyLink")}</span>
    </button>
  );
}
