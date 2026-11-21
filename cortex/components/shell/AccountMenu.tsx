"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { UserRound, LogOut } from "lucide-react";
import { signOut } from "next-auth/react";
import { useTranslations } from "use-intl/react";

/**
 * Icône compte du Topbar : un simple lien vers /compte ne laissait nulle part, en haut de
 * l'app, de sortie rapide — se déconnecter exigeait d'ouvrir /compte. Disclosure non modale
 * (pas de rôle menu : deux liens/boutons ordinaires, pas de navigation aux flèches à coder).
 */
export function AccountMenu() {
  const t = useTranslations("shell");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("account")}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="account-menu-panel"
        onClick={() => setOpen((v) => !v)}
        className="hidden size-11 min-[360px]:grid place-items-center rounded-lg border border-line bg-surface-2/50 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-1"
      >
        <UserRound className="size-[1.15rem]" strokeWidth={2} aria-hidden="true" />
      </button>

      {open && (
        <div
          id="account-menu-panel"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-30 min-w-[11rem] overflow-hidden rounded-xl border border-line-strong bg-surface-1 py-1.5 shadow-[var(--shadow-pop)]"
        >
          <Link
            href="/compte"
            onClick={() => setOpen(false)}
            className="flex min-h-11 items-center gap-2.5 px-3.5 text-[0.88rem] text-ink-1 transition-colors hover:bg-surface-2"
          >
            <UserRound className="size-4 shrink-0 text-ink-3" strokeWidth={2} aria-hidden="true" />
            {t("account")}
          </Link>
          <button
            type="button"
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="flex min-h-11 w-full items-center gap-2.5 px-3.5 text-left text-[0.88rem] text-ink-1 transition-colors hover:bg-surface-2"
          >
            <LogOut className="size-4 shrink-0 text-ink-3" strokeWidth={2} aria-hidden="true" />
            {t("signOut")}
          </button>
        </div>
      )}
    </div>
  );
}
