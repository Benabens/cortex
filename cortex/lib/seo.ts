import type { Metadata } from "next";

/**
 * INDEXATION — l'application est une surface PRIVÉE : tout est derrière la
 * connexion, et son contenu (corpus d'un étudiant, examens générés) n'a rien à
 * faire dans un moteur de recherche. La vitrine porte le référencement et son
 * sitemap ; l'app se contente d'un robots.txt fermé (app/robots.ts) et de
 * `noindex` sur ses pages, sauf l'écran de connexion — la seule porte publique.
 */
export const NOINDEX: Metadata = { robots: { index: false, follow: false } };
export const INDEXABLE: Metadata = { robots: { index: true, follow: true } };
