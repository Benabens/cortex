/**
 * PRÉ-LANCEMENT 2 — l'écran de révision avalait l'erreur réseau (`catch {}`) et
 * restait en squelette pour toujours : ni message, ni moyen de réessayer. Les
 * huit autres écrans répètent le même bloc d'erreur ; il devient un composant
 * partagé, testable, et la révision passe par `useApi` comme eux.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const render = async (props: Record<string, unknown>) => {
  const { LoadError } = await import("../components/ui/LoadError");
  return renderToStaticMarkup(createElement(LoadError, props as never));
};

test("LoadError : titre, explication, bouton Réessayer actif", async () => {
  const html = await render({ title: "Impossible de charger la révision", hint: "Le moteur ne répond pas pour ce cours.", onRetry: () => {} });
  assert.match(html, /Impossible de charger la révision/);
  assert.match(html, /Le moteur ne répond pas pour ce cours\./);
  assert.match(html, /Réessayer/);
  const button = /<button[^>]*>/.exec(html)?.[0] ?? "";
  assert.ok(button, "un bouton est rendu");
  assert.ok(!/\sdisabled(?:=""|(?=[\s>]))/.test(button), "le bouton de reprise n'est jamais désactivé");
});

test("LoadError : sans reprise possible, aucun bouton mais le message reste", async () => {
  const html = await render({ title: "Hors ligne" });
  assert.match(html, /Hors ligne/);
  assert.ok(!/<button/.test(html));
});

test("l'écran de révision passe par useApi et affiche l'état d'erreur (plus de catch muet)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("app/revision/page.tsx", "utf8");
  assert.match(src, /useApi</, "les données viennent du crochet commun, qui expose error et refetch");
  assert.match(src, /LoadError/, "l'état d'erreur est rendu");
  assert.ok(!/\bfetch\(/.test(src), "plus de fetch maison avalant l'erreur : tout passe par le crochet commun");
});
