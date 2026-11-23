"use client";

import { SafeHtml } from "@/components/ui/SafeHtml";
import { useMathHtml } from "@/lib/ux/math";

/**
 * Texte du modèle (énoncé, option, explication, retour) avec ses formules mises en forme : le
 * serveur les compose (POST /api/math) ; en attendant, ou sans formule, le texte s'affiche tel quel.
 * En ligne : hérite de la police, de la couleur et du `white-space` de son parent.
 */
export function MathText({ text }: { text: string | null | undefined }) {
  const html = useMathHtml(text ?? "");
  return html === null ? <>{text}</> : <SafeHtml as="span" math html={html} />;
}
