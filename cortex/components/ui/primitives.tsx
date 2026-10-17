import { useId } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/ux/cn";

/** Base card surface. Use `interactive` for hoverable tiles. */
export function Panel({
  className,
  interactive = false,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        "panel",
        interactive &&
          "transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-[color-mix(in_oklch,var(--color-violet)_34%,transparent)] hover:shadow-[var(--shadow-pop)]",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function SectionHeader({
  title,
  hint,
  action,
  className,
}: {
  title: string;
  hint?: string;
  action?: { label: string; href: string };
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-end justify-between gap-4", className)}>
      <div>
        <h2 className="text-[0.95rem] font-semibold text-ink-1">{title}</h2>
        {hint && <p className="mt-0.5 text-[0.8rem] text-ink-3">{hint}</p>}
      </div>
      {action && (
        <Link
          href={action.href}
          className="group -mx-2 -my-3 inline-flex min-h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded px-2 text-[0.8rem] font-medium text-ink-3 transition-colors hover:text-violet-hi focus-visible:text-violet-hi"
        >
          {action.label}
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      )}
    </div>
  );
}

/**
 * Interrupteur (même mécanique que Kairo, 17/10) : un vrai `<input type="checkbox" role="switch">` dans un
 * `<label>` ; le dessin et le mouvement sont dans app/globals.css (« Interrupteur »). La pastille glisse
 * (translateX) et s'étire en largeur du côté où elle va (ses deux bords sont animés séparément), rebondit
 * d'un pixel et s'élargit dès l'appui ; relâcher hors de l'étiquette annule. Mouvement réduit : bascule nette.
 * `label` nomme l'interrupteur : visible avec `labelVisible`, sinon pour les lecteurs d'écran seulement.
 * Espace est natif, Entrée bascule aussi.
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
        onChange={(e) => onChange(e.target.checked)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.click();
          }
        }}
      />
      <span className="sw-track" aria-hidden="true">
        <span className="sw-thumb" />
      </span>
      <span className={labelVisible ? "sw-text" : "sr-only"}>
        {label}
        {labelVisible && hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}
