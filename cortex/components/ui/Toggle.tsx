"use client";

import { useId } from "react";
import { cn } from "@/lib/ux/cn";

/**
 * Interrupteur binaire : un vrai checkbox, dont les deux bords de la pastille sont animés
 * séparément. Le bord avant part le premier, le bord arrière le rejoint avec un léger rebond.
 * Entrée complète le comportement clavier natif (Espace) ; le mouvement réduit est géré en CSS.
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  autoFocus = false,
  labelVisible = false,
  hint,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  autoFocus?: boolean;
  labelVisible?: boolean;
  hint?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <label className={cn("switch", className)} htmlFor={id} data-disabled={disabled ? "" : undefined}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.checked)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className={labelVisible ? "switch-text" : "sr-only"}>
        {label}
        {labelVisible && hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}
