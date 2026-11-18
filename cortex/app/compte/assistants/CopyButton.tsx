"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/ux/cn";
import { useTranslations } from "use-intl/react";

/**
 * Copie `text` dans le presse-papiers. Sans API presse-papiers (page non sécurisée,
 * navigateur ancien), sélectionne le bloc ciblé par `selectId` pour un copier manuel.
 */
export function CopyButton({ text, label, selectId, className }: { text: string; label: string; selectId?: string; className?: string }) {
  const t = useTranslations("account.assistants.copy");
  const [state, setState] = useState<"idle" | "done" | "manual">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      const el = selectId ? document.getElementById(selectId) : null;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setState("manual");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2200);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 text-[0.78rem] font-medium text-ink-2",
        "transition-colors duration-150 hover:bg-surface-3 hover:text-ink-1",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        className,
      )}
      aria-label={state === "done" ? t("doneLabel", { label }) : label}
    >
      {state === "done" ? <Check className="size-3.5" strokeWidth={2.25} aria-hidden="true" /> : <Copy className="size-3.5" strokeWidth={2.25} aria-hidden="true" />}
      <span aria-live="polite">{state === "done" ? t("done") : state === "manual" ? t("manual") : t("copy")}</span>
    </button>
  );
}
