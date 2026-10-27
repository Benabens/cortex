"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/lib/ux/use-theme";

/**
 * Bascule rapide clair / sombre de la barre du haut. Fixe un choix explicite (le retour à
 * « Système » se fait dans Compte → Apparence). L'icône montre le thème en cours et suit
 * `data-theme` en CSS (globals.css, .theme-icon-*) : la bonne icône dès le premier rendu,
 * sans attendre l'hydratation.
 */
export function ThemeToggle() {
  const { theme, setPref } = useTheme();
  const light = theme === "light";

  return (
    <button
      type="button"
      onClick={() => setPref(light ? "dark" : "light")}
      aria-label="Thème clair"
      aria-pressed={light}
      title={light ? "Passer en thème sombre" : "Passer en thème clair"}
      className="grid size-11 place-items-center rounded-lg border border-line bg-surface-2/50 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-1"
    >
      <Moon className="theme-icon-moon size-[1.15rem]" strokeWidth={2} aria-hidden="true" />
      <Sun className="theme-icon-sun size-[1.15rem]" strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
