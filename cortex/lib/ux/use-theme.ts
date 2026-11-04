"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  LIGHT_QUERY,
  THEME_COLORS,
  THEME_STORAGE_KEY,
  parseThemePref,
  resolveTheme,
  type Theme,
  type ThemePref,
} from "./theme";

/** Événement interne : la barre du haut et la page Compte restent d'accord dans le même onglet. */
const CHANGE = "cortex:theme";

function systemTheme(): Theme {
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}

function readPref(): ThemePref {
  try {
    return parseThemePref(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function syncThemeColor(theme: Theme) {
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((m) => (m.content = THEME_COLORS[theme]));
}

/**
 * Pose le thème sur <html>. Les transitions sont suspendues le temps d'une image : sans ça,
 * chaque élément `transition-colors` changerait de teinte à sa propre vitesse.
 */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (root.dataset.theme !== theme) {
    root.classList.add("theme-switching");
    root.dataset.theme = theme;
    void getComputedStyle(root).color; // applique les nouveaux jetons tant que les transitions sont coupées
    requestAnimationFrame(() => root.classList.remove("theme-switching"));
  }
  syncThemeColor(theme);
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia(LIGHT_QUERY);
  const onSystem = () => {
    if (readPref() === "system") applyTheme(systemTheme());
    onChange();
  };
  // Choix fait dans un autre onglet.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== THEME_STORAGE_KEY) return;
    applyTheme(resolveTheme(readPref(), systemTheme()));
    onChange();
  };
  media.addEventListener("change", onSystem);
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE, onChange);
  return () => {
    media.removeEventListener("change", onSystem);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE, onChange);
  };
}

// Instantané primitif (useSyncExternalStore compare par égalité stricte) : « préférence|thème ».
// Le thème affiché est celui de <html>, posé par le script du <head> : c'est la seule vérité.
function getSnapshot() {
  const theme: Theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  return `${readPref()}|${theme}`;
}
const getServerSnapshot = () => "system|dark";

/**
 * Préférence de thème (« system » | « light » | « dark ») et thème réellement affiché.
 * Au rendu serveur et à l'hydratation : « system » / « dark », puis la vraie valeur.
 */
export function useTheme() {
  const [pref, theme] = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot).split("|") as [
    ThemePref,
    Theme,
  ];

  useEffect(() => syncThemeColor(theme), [theme]);

  const setPref = useCallback((next: ThemePref) => {
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Stockage bloqué : le choix vaut pour cette page seulement.
    }
    applyTheme(resolveTheme(next, systemTheme()));
    window.dispatchEvent(new Event(CHANGE));
  }, []);

  return { pref, theme, setPref };
}
