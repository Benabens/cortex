"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/ux/cn";
import { usePress } from "@/lib/ux/press";

type IconType = React.ComponentType<{ className?: string; strokeWidth?: number }>;

export type SegmentedOption<V extends string> = {
  value: V;
  label: string;
  Icon?: IconType;
  /** Compteur affiché après le libellé (filtres). */
  count?: number;
  /** Couleur du libellé quand l'option est choisie (facettes de la recherche). */
  tone?: string;
};

/**
 * - `track` : options réunies dans un rail (« Par section / Par priorité ») ;
 * - `pills` : pastilles séparées, arrondi complet (filtres de sévérité, facettes de recherche) ;
 * - `chips` : pastilles séparées, arrondi moyen (facettes du corpus) ;
 * - `line`  : texte seul, l'option choisie est soulignée (sévérité d'une faiblesse).
 */
type Variant = "track" | "pills" | "chips" | "line";
type Size = "sm" | "md";

const rootStyle: Record<Variant, string> = {
  track: "gap-1 rounded-lg border border-line bg-surface-1/60 p-1",
  pills: "flex-wrap gap-2",
  chips: "flex-wrap gap-2",
  line: "",
};

const optionStyle: Record<Variant, Record<Size, string>> = {
  track: {
    sm: "h-8 rounded-md px-2.5 text-[0.78rem]",
    md: "h-10 rounded-md px-3 text-[0.82rem]",
  },
  pills: {
    sm: "h-9 rounded-full border border-line bg-surface-1/60 px-3 text-[0.82rem]",
    md: "h-9 rounded-full border border-line bg-surface-1/60 px-3 text-[0.82rem]",
  },
  chips: {
    sm: "h-9 rounded-md border border-line bg-surface-1/60 px-2.5 text-[0.8rem]",
    md: "h-9 rounded-md border border-line bg-surface-1/60 px-2.5 text-[0.8rem]",
  },
  line: {
    sm: "min-h-11 rounded px-1.5 text-[0.8rem]",
    md: "min-h-11 rounded px-1.5 text-[0.8rem]",
  },
};

const VIOLET_THUMB =
  "border border-[color-mix(in_oklch,var(--color-violet)_45%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_14%,transparent)]";

const thumbStyle: Record<Variant, string> = {
  track: "rounded-md bg-surface-2 shadow-[0_0_0_1px_var(--color-line-strong)]",
  pills: cn("rounded-full", VIOLET_THUMB),
  chips: cn("rounded-md", VIOLET_THUMB),
  line: "seg-thumb-line",
};

type Box = { l: number; r: number; t: number; b: number };

/**
 * Le seul contrôle à bascule « une option parmi N » de l'app : vues, tris, filtres.
 *
 * L'indicateur est un élément à part, posé derrière les libellés, qui glisse d'une option à
 * l'autre. Ses deux bords ne voyagent pas à la même vitesse : celui qui est en tête arrive
 * vite, celui qui suit est tenu par un ressort. Entre les deux l'indicateur s'étire (sa largeur
 * change vraiment, ses coins ne se déforment pas comme avec un `scaleX`), puis le bord suiveur
 * dépasse légèrement sa cible et revient : le rebond se joue à l'intérieur de l'indicateur, il
 * ne déborde jamais du rail. Les courbes sont les jetons `--spring-*` de globals.css.
 *
 * À l'appui, l'option se comprime et l'indicateur se tend vers elle ; rien ne change avant le
 * relâché (cf. `usePress`), donc glisser hors du bouton annule.
 *
 * Accessibilité : groupe de boutons radio (`radiogroup` / `radio` + `aria-checked`), un seul
 * arrêt de tabulation, flèches / Début / Fin pour changer d'option. Avec
 * `prefers-reduced-motion`, la règle globale ramène toutes ces transitions à une bascule
 * instantanée.
 */
export function Segmented<V extends string>({
  options,
  value,
  onChange,
  label,
  variant = "track",
  size = "md",
  className,
}: {
  options: SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Nom du groupe pour les lecteurs d'écran (« Organiser les notions »). */
  label: string;
  variant?: Variant;
  size?: Size;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const last = useRef<Box | null>(null);
  const { pressed, bind } = usePress<V>();

  const activeIndex = options.findIndex((o) => o.value === value);
  const pressedIndex = pressed == null ? -1 : options.findIndex((o) => o.value === pressed);
  const press =
    pressedIndex < 0 || activeIndex < 0
      ? undefined
      : pressedIndex === activeIndex
        ? "active"
        : pressedIndex > activeIndex
          ? "right"
          : "left";

  /** Pose l'indicateur sur l'option choisie. `animate: false` = sans transition (montage, redimensionnement). */
  const place = useCallback((animate: boolean) => {
    const box = root.current;
    const el = thumb.current;
    if (!box || !el) return;
    const on = box.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
    if (!on) {
      delete box.dataset.placed;
      last.current = null;
      return;
    }
    // Rectangles réels plutôt que offsetLeft / offsetWidth, qui arrondissent au pixel : un libellé
    // de 117,9 px donnerait un indicateur de 118. Repère = boîte de remplissage du groupe, dont
    // la bordure est la même des quatre côtés (clientLeft / clientTop).
    const g = box.getBoundingClientRect();
    const o = on.getBoundingClientRect();
    const px = (n: number) => Math.round(n * 100) / 100;
    const next: Box = {
      l: px(o.left - g.left - box.clientLeft),
      t: px(o.top - g.top - box.clientTop),
      r: px(g.right - box.clientLeft - o.right),
      b: px(g.bottom - box.clientTop - o.bottom),
    };
    const prev = last.current;
    if (prev && prev.l === next.l && prev.r === next.r && prev.t === next.t && prev.b === next.b) return;
    const instant = !animate || !prev;
    if (instant) el.style.transition = "none";
    else box.dataset.dir = next.l < prev.l ? "left" : "right";
    el.style.setProperty("--seg-l", `${next.l}px`);
    el.style.setProperty("--seg-r", `${next.r}px`);
    el.style.setProperty("--seg-t", `${next.t}px`);
    el.style.setProperty("--seg-b", `${next.b}px`);
    box.dataset.placed = "";
    if (instant) {
      void el.offsetWidth; // fige la position avant de rendre la main aux transitions
      el.style.transition = "";
    }
    last.current = next;
  }, []);

  useLayoutEffect(() => place(true), [place, value]);

  // Libellés, compteurs ou largeur disponible qui changent : l'indicateur suit, sans animation.
  useEffect(() => {
    const box = root.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(box);
    box.querySelectorAll('[role="radio"]').forEach((b) => ro.observe(b));
    return () => ro.disconnect();
  }, [place, options.length]);

  const move = (e: React.KeyboardEvent<HTMLElement>, from: number) => {
    const last = options.length - 1;
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? from === last ? 0 : from + 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? from === 0 ? last : from - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    if (to < 0) return;
    e.preventDefault();
    if (to === from) return;
    onChange(options[to].value);
    root.current?.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
  };

  return (
    <div
      ref={root}
      role="radiogroup"
      aria-label={label}
      data-press={press}
      className={cn("seg", rootStyle[variant], className)}
    >
      <span ref={thumb} aria-hidden="true" className={cn("seg-thumb", thumbStyle[variant])} />
      {options.map((o, i) => {
        const checked = i === activeIndex;
        const p = bind(o.value);
        return (
          <Fragment key={o.value}>
          {variant === "line" && i > 0 && (
            <span className="px-0.5 text-ink-4" aria-hidden="true">
              ·
            </span>
          )}
          <button
            type="button"
            role="radio"
            aria-checked={checked}
            // Un seul arrêt de tabulation : l'option choisie (la première si aucune ne l'est).
            tabIndex={checked || (activeIndex < 0 && i === 0) ? 0 : -1}
            data-pressed={pressed === o.value ? "" : undefined}
            onClick={() => !checked && onChange(o.value)}
            {...p}
            onKeyDown={(e) => {
              p.onKeyDown(e);
              move(e, i);
            }}
            className={cn(
              "seg-opt font-medium transition-colors duration-150",
              optionStyle[variant][size],
              checked
                ? "text-ink-1"
                : variant === "track" || variant === "line"
                  ? "text-ink-3 hover:text-ink-1"
                  : "text-ink-2 hover:bg-surface-2 hover:text-ink-1"
            )}
          >
            <span className={cn("seg-label", size === "sm" && variant === "track" ? "gap-1.5" : "gap-2")}>
              {o.Icon && <o.Icon className={size === "sm" || variant !== "track" ? "size-3.5" : "size-4"} strokeWidth={2} />}
              <span style={checked && o.tone ? { color: o.tone } : undefined}>{o.label}</span>
              {o.count != null && <span className="font-data text-[0.72rem] tabular text-ink-4">{o.count}</span>}
            </span>
          </button>
          </Fragment>
        );
      })}
    </div>
  );
}
