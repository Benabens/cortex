"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { Wordmark } from "./Logo";
import { CourseSelector } from "./CourseSelector";
import { NavList } from "./NavList";

export function MobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-50 lg:hidden ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
      inert={!open}
    >
      {/* scrim */}
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      {/* drawer */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Menu de navigation"
        className={`absolute inset-y-0 left-0 flex w-[min(84vw,320px)] flex-col border-r border-line bg-bg shadow-[var(--shadow-hero)] transition-transform duration-300 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ transitionTimingFunction: "var(--ease-out-quint)" }}
      >
        <div className="flex h-16 items-center justify-between px-5">
          <Wordmark markSize={28} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer le menu"
            className="grid size-11 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-1"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="px-3">
          <CourseSelector />
        </div>
        <div className="mt-4 flex-1 overflow-y-auto px-3">
          <NavList onNavigate={onClose} />
        </div>
      </div>
    </div>
  );
}
