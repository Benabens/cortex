# Plan : interface de Cortex en plusieurs langues (i18n étape 2)

Statut : **plan seulement, aucun code**. Étape 1 (PR `langue-examens-correction`) : la sortie
d'examen (PDF, corrigés, correction) suit déjà la langue de l'examen. Reste l'interface, toute
en français (audit du 16/11/2026, `audit5-parcours-i18n.md`, #3, #13-#18, #26-#32).

## Décision à prendre par Ben avant la PR 1

CONTRIBUTING.md impose « Interface et messages utilisateur en français ». Ce plan suppose qu'on
le remplace par « Interface en français et en anglais ; tout texte visible passe par les
dictionnaires ». Si Ben préfère rester francophone, seule la PR 0 (ci-dessous) a du sens, et la
landing doit dire que l'app est en français.

## Ce qu'il y a à traduire (mesuré sur main, 16/11/2026)

| Surface | Volume | Où |
|---|---|---|
| Pages et composants | 89 fichiers `.tsx`, 16 pages, 84 fichiers avec du texte français, au moins 400 chaînes | `app/`, `components/` |
| Erreurs d'API | 152 `NextResponse.json({ error })`, phrases françaises sans code | `app/api/**` |
| Connecteur MCP | résumés et erreurs des 18 outils, confirmation de paiement (élicitation) | `lib/mcp/**` |
| E-mails | connexion, rappel de renouvellement, reçu de rétractation | `lib/auth-providers.ts`, `lib/billing/renewal-reminders.ts`, `app/api/account/withdrawal` |
| Textes juridiques | consentement de rétractation, CGV (FR fait foi) | `lib/consumer-law.ts`, `lib/legal.ts` |
| Formats | nombres, prix, dates en `fr-CH` / `fr-FR` en dur, fuseau Zurich non nommé | 11 fichiers (audit #26, #27) |

## Bibliothèque recommandée : `next-intl` (v4)

- Faite pour l'App Router de Next 16 : `getTranslations()` dans les Server Components (aucun
  JavaScript envoyé pour un texte statique), `useTranslations()` dans les Client Components.
- Messages ICU (pluriels, `{count, plural, …}`, dates et nombres via `Intl`) : remplace les
  `plural()` et `Intl.NumberFormat("fr-CH")` écrits à la main.
- Mode **sans préfixe d'URL** (`/fr/…` inutile : l'app est derrière connexion, pas de SEO à
  gagner ; la landing est un projet Vercel à part). La langue vient d'une fonction
  `getRequestConfig` qui lit, dans l'ordre : la préférence du compte, le cookie `cortex_locale`,
  `Accept-Language`, puis `fr`.
- Typage des clés : `declare module "next-intl"` avec le type du dictionnaire français → une clé
  manquante ou mal tapée casse `tsc` (donc la CI).
- Écartées : `react-i18next` (pensée pour le client, intégration RSC manuelle), `lingui`
  (extraction par macro et étape de compilation en plus), dictionnaires maison (il faudrait
  refaire pluriels, formats et typage).

## Détection de la langue

1. **Compte** : colonne `users.locale` (`fr` | `en`, NULL = pas choisi), réglage dans `/compte`.
   Source de vérité pour les e-mails et le MCP, qui n'ont pas de navigateur.
2. **Cookie** `cortex_locale` posé par le sélecteur de langue (aussi avant connexion, page
   `/login`).
3. **`Accept-Language`** : parsé dans `proxy.ts` (le middleware de Next 16) avec
   `@formatjs/intl-localematcher` + `negotiator` (ce que next-intl utilise déjà), restreint aux
   langues livrées. Au premier login, la langue négociée est copiée dans `users.locale`.
4. Repli `fr` (le public actuel).

`<html lang>` devient dynamique (`app/layout.tsx`), et le contenu de cours garde **sa** langue :
`lang={course.language}` sur les conteneurs d'examen, d'entraînement et de recherche (WCAG 3.1.2,
audit #18) — un énoncé anglais dans une interface française est lu avec la voix anglaise.

## Découpage en PR

| PR | Contenu | Critère de fin | Estimation |
|---|---|---|---|
| **0. Codes d'erreur** | Les 152 erreurs d'API renvoient `{ code, params, error }` (message FR gardé, compatible) ; MCP : messages en anglais + `code` stable (la consigne du serveur dit déjà « answer in the student's language ») ; confirmation de paiement MCP en anglais avec les montants en champs structurés (#14, #15, #17) | tests d'API existants verts, un test par code ; aucun texte d'erreur nouveau sans code | 1,5 j |
| **1. Socle** | `next-intl`, `getRequestConfig`, `proxy.ts` (Accept-Language + cookie), `users.locale` (migration SQLite + Postgres), `<html lang>` dynamique, sélecteur dans `/compte` et `/login`, helper `fmt(locale)` pour nombres, prix et dates, fuseau affiché (#26, #27) ; CONTRIBUTING mis à jour | `Accept-Language: en` → `<html lang="en">` sur `/login` (test E2E Playwright) ; FR inchangé byte pour byte sur les captures | 1,5 j |
| **2. Parcours d'arrivée** | `/login`, e-mail de connexion, onboarding, création de cours, imports, erreurs 404 / crash, manifeste PWA (#13, #32 : `<label>` du champ e-mail) | un étudiant anglophone crée un cours et importe une annale sans lire de français (E2E) | 2 j |
| **3. Cœur** | examen blanc, entraînement, correction, révision, programme, résultats ; `lang` du contenu de cours (#18) | E2E du parcours complet en anglais ; audit axe WCAG 3.1.2 | 2,5 j |
| **4. Compte et argent** | `/compte`, crédits, usage, applications connectées, suppression de compte (mot de confirmation dans la langue, les deux acceptés, #31), consentement de rétractation bilingue avec FR faisant foi (#16), rappels et reçus dans la langue du compte (#28) | relecture juridique de la version EN par Ben ; tests Stripe en mode test seulement | 1,5 j |
| **5. Garde-fou** | test qui échoue si une chaîne française littérale apparaît dans un `.tsx` hors dictionnaire (liste blanche pour le contenu de cours) ; dictionnaire EN relu par un anglophone | CI verte avec le garde-fou actif | 0,5 j |

**Total : environ 9,5 jours** de travail, PR 0 et 1 en premier (elles débloquent les autres,
qui peuvent ensuite partir en parallèle sur des worktrees distincts). L'extraction des chaînes
des PR 2-4 est mécanique : bon candidat pour `codex exec`, avec relecture complète ensuite.

## Hors périmètre

- Une troisième langue d'interface (DE) : le socle la permet, la traduction coûte ~1 j de plus
  par langue une fois les dictionnaires stables.
- La landing `cortexexam.com` (projet Vercel séparé).
- La langue des examens et des corrigés : déjà traitée en étape 1 (7 langues).
