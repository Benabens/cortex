"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Wordmark } from "./Logo";
import { CourseSelector } from "./CourseSelector";
import Link from "next/link";
import { NavList } from "./NavList";

export function MobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);

  useEffect(() => {
    const node = dialog.current;
    if (!node || !open) return;
    // Le dialogue natif isole le fond, retient le focus et le rend au bouton d’ouverture.
    const previousOverflow = document.body.style.overflow;
    node.showModal();
    document.body.style.overflow = "hidden";
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onResize = () => { if (desktop.matches) close.current(); };
    desktop.addEventListener("change", onResize);
    return () => {
      node.close();
      document.body.style.overflow = previousOverflow;
      desktop.removeEventListener("change", onResize);
    };
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-label="Navigation"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), select:not([disabled]), [tabindex="0"]'
        )).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      className="drawer-dialog fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-transparent p-0 text-ink-1 backdrop:bg-scrim backdrop:backdrop-blur-sm"
    >
      <button type="button" onClick={onClose} aria-label="Fermer le menu de navigation"
        tabIndex={-1} className="absolute inset-0 cursor-default" />
      {/* Glissement d'entrée et de sortie en CSS (globals.css, .drawer-dialog) : le dialogue
          natif s'ouvre et se ferme d'un coup, @starting-style anime le tiroir à partir de là. */}
      <div className="drawer-panel absolute inset-y-0 left-0 flex w-[min(84vw,320px)] flex-col border-r border-line bg-[var(--drawer-bg)] shadow-[var(--shadow-hero)]">
        <div className="flex h-16 items-center justify-between px-5">
          <Wordmark markSize={28} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer le menu"
            autoFocus
            className="grid size-11 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-1"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="px-3">
          <CourseSelector />
        </div>
        <div className="mt-4 flex-1 overflow-y-auto overscroll-contain px-3">
          <NavList onNavigate={onClose} />
          <div className="my-3 border-t border-line" />
          <Link href="/cours" onClick={onClose} className="flex min-h-11 items-center px-3 text-sm text-ink-2">Gérer mes cours</Link>
        </div>
      </div>
    </dialog>
  );
}
