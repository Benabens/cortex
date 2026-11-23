"use client";

import { useEffect, useSyncExternalStore } from "react";
import { MATH_MAX_CHARS, MATH_MAX_TEXTS, MATH_MAX_TOTAL_CHARS } from "@/lib/math-limits";

/**
 * FORMULES À L'ÉCRAN, CÔTÉ CLIENT : aucun moteur de maths dans le navigateur. Le texte qui peut en
 * contenir part en un seul lot vers POST /api/math (rendu KaTeX côté serveur, lib/math-html) ;
 * tant que la réponse n'est pas là, ou si elle échoue, la vue garde son texte tel quel (un échec
 * n'est pas retenu : la prochaine vue qui affiche ce texte redemande).
 */

/** Une formule a toujours un « $ », un « \ » (\(…\), \[…\], commande) ou un indice / exposant. */
const MAYBE_FORMULA = /[$\\^_]/;
const CACHE_MAX = 2000;

const done = new Map<string, string | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function settle(text: string, html: string | null) {
  if (done.size >= CACHE_MAX) done.delete(done.keys().next().value!);
  done.set(text, html);
}

/** Les textes en lots sous les bornes de la route (lib/math-limits). */
function lots(texts: string[]): string[][] {
  const out: string[][] = [];
  let lot: string[] = [];
  let chars = 0;
  for (const t of texts) {
    if (lot.length && (lot.length >= MATH_MAX_TEXTS || chars + t.length > MATH_MAX_TOTAL_CHARS)) {
      out.push(lot);
      lot = [];
      chars = 0;
    }
    lot.push(t);
    chars += t.length;
  }
  if (lot.length) out.push(lot);
  return out;
}

async function flush() {
  timer = null;
  const texts = [...pending];
  pending.clear();
  for (const lot of lots(texts)) {
    let html: unknown[] | null = null;
    try {
      const res = await fetch("/api/math", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texts: lot }) });
      if (res.ok) html = ((await res.json()) as { html?: unknown[] }).html ?? null;
    } catch {
      // hors ligne ou serveur indisponible : le texte reste affiché tel quel
    }
    if (!html) continue;
    lot.forEach((t, k) => settle(t, typeof html[k] === "string" ? (html[k] as string) : null));
    for (const l of listeners) l();
  }
}

function request(text: string) {
  if (text.length > MATH_MAX_CHARS || done.has(text) || pending.has(text)) return;
  pending.add(text);
  // un seul lot pour tout ce qu'une page monte d'un coup (options, énoncés, explications)
  timer ??= setTimeout(flush, 0);
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Le HTML composé par le serveur pour `text`, ou null (pas de formule, pas encore reçu, échec). */
export function useMathHtml(text: string): string | null {
  const maybe = MAYBE_FORMULA.test(text);
  const html = useSyncExternalStore(subscribe, () => (maybe ? done.get(text) ?? null : null), () => null);
  useEffect(() => {
    if (maybe) request(text);
  }, [text, maybe]);
  return html;
}
