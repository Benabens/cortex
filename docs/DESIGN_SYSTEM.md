# Cortex — design system de l’application en ligne

## Typographie — décision du 5 novembre 2026

Cette règle remplace les anciennes consignes « Funnel Display pour les titres » et « police système pour le corps ».

| Rôle | Famille | Token |
|---|---|---|
| Logo cortex | Funnel Display 700, inchangé | --font-brand / font-brand |
| Interface, navigation, formulaires | Inter variable | --font-sans / font-sans |
| Titres, sections, offres, compteurs | Inter variable | --font-display / font-display |
| Code et références monospace | Police native existante, SF Mono / Menlo | --font-mono / font-mono |

Inter est la famille observée sur le site et la démonstration officielle de Linear le 5 novembre 2026 : https://linear.app/ et https://linear.app/demo.
Linear utilise également Berkeley Mono. Cette fonte commerciale n'est pas intégrée sans licence et fichiers autorisés ; le monospace actuel reste en place. Ne pas présenter la pile de repli comme une copie exacte de Berkeley Mono.

Les tailles, graisses, interlignes et espacements actuels de Cortex sont conservés. La demande concerne les familles typographiques, pas une refonte des pages.
Les thèmes clair/sombre/système, couleurs, mises en page, menus, fonctionnalités et parcours existants restent inchangés.

## Implémentation

- cortex/app/typography.css : déclarations locales de fontes, font-display: swap.
- cortex/app/globals.css : tokens partagés ; tous les titres et composants utilisant font-display deviennent Inter.
- cortex/components/shell/Logo.tsx : seul usage de font-brand ; forme, graisse et taille inchangées.
- cortex/app/global-error.tsx : Inter et logo Funnel Display disponibles dans le document de secours indépendant.
- cortex/public/brand/fonts : fichiers locaux et licences OFL. Aucun CDN requis pour Inter.
- Funnel Display du logo normal continue d'être servi par next/font. L'alias Cortex Brand est réservé au document de secours afin de ne pas remplacer la fonte du logo principal.

Ne pas utiliser font-brand pour un titre, une offre, un nombre ou un bouton.
Ne pas ajouter de police différente dans une page ; employer les tokens.
Conserver la composition mathématique et les polices des PDF générés : elles suivent le format des examens, pas l'interface.
Valider les retours à la ligne sur mobile et dans les deux thèmes lors d'une modification typographique.
