/**
 * THÈME — sombre (défaut) ou clair, via `data-theme` sur <html> (jetons : app/globals.css).
 *
 * Le choix vit dans le navigateur (localStorage) : l'app n'a pas de table de préférences
 * utilisateur. « Système » = pas de clé enregistrée, le thème suit `prefers-color-scheme`.
 *
 * Module sans dépendance au DOM ni à React : le script d'initialisation et la résolution
 * sont testés côté Node (tests/theme.test.ts). Le hook client est dans lib/ux/use-theme.ts.
 */

export type Theme = "light" | "dark";
export type ThemePref = "system" | Theme;

export const THEME_STORAGE_KEY = "cortex-theme";
export const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** Couleur de la barre du navigateur (meta theme-color) : le fond de chaque thème. */
export const THEME_COLORS: Record<Theme, string> = { dark: "#0c0d15", light: "#f4f6fb" };

/** Valeur enregistrée → préférence. Tout ce qui n'est pas « light » / « dark » vaut « système ». */
export function parseThemePref(raw: string | null | undefined): ThemePref {
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function resolveTheme(pref: ThemePref, system: Theme): Theme {
  return pref === "system" ? system : pref;
}

/** Caractères que React échappe dans un nœud texte : interdits dans les scripts ci-dessous. */
export const HTML_ESCAPED_CHARS = /[&<>"']/;

/**
 * Script inline du <head> (app/layout.tsx) : pose `data-theme` AVANT le premier rendu, donc
 * pas de flash du mauvais thème. Il doit rester autonome (aucune importation n'existe à ce
 * moment) et ne jamais lever : localStorage peut être bloqué, auquel cas il reste en sombre.
 *
 * Rendu comme ENFANT TEXTE de <script> : l'injection de HTML brut est réservée à SafeHtml
 * (cf. tests/sanitize-html.test.ts). Il ne contient donc aucun caractère que React échapperait
 * (chaînes entre accents graves, aucun & < > " '). tests/theme.test.ts le vérifie.
 */
const tpl = (s: string) => "`" + s + "`";
export const THEME_INIT_SCRIPT =
  `(function(){var d=document.documentElement,t=${tpl("dark")};try{` +
  `var p=localStorage.getItem(${tpl(THEME_STORAGE_KEY)});` +
  `t=p===${tpl("light")}||p===${tpl("dark")}?p:window.matchMedia(${tpl(LIGHT_QUERY)}).matches?${tpl("light")}:${tpl("dark")}` +
  `}catch(e){}d.setAttribute(${tpl("data-theme")},t)})()`;
