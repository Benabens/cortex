"use client";

import { cn } from "@/lib/ux/cn";
import { usePress } from "@/lib/ux/press";

/**
 * Interrupteur binaire (oui / non). Même mouvement que `Segmented`, à l'échelle du bouton :
 * le curseur glisse, s'étire en chemin, rebondit à l'arrivée, et se comprime tant qu'on appuie.
 * Rail 44 × 24, curseur de 20 px tenu à 2 px des bords : les positions sont dans globals.css
 * (`.switch`, `.switch-knob`), pilotées par `aria-checked`.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  autoFocus = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const { pressed, bind } = usePress();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      autoFocus={autoFocus}
      data-pressed={pressed && !disabled ? "" : undefined}
      onClick={() => onChange(!checked)}
      {...bind(true)}
      className={cn(
        "switch h-6 w-11 shrink-0 rounded-full transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-2",
        checked
          ? "bg-violet-deep shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
          : "bg-surface-3 shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]",
        disabled && "cursor-not-allowed opacity-45"
      )}
    >
      <span aria-hidden="true" className="switch-knob" />
    </button>
  );
}
