# Moteur QCM 2026 : comparatif des architectures A–E (15/11/2026)

Banc fixe `hum-285-job14` (20 QCM, HUM-285), moteur sur `claude-code` (abonnement Max, sans clé), coût converti au tarif API Sonnet 5 (2 / 10 $ par M, cache 0,2 / 2,5) depuis les tokens mesurés. Qualité au juge du banc (rubrique figée), moyenne ± écart sur 3 runs sauf mention. Détail des itérations : `BOUCLE-MOTEUR.md`.

| option | statut | $ / QCM (API) | latence perçue | qualité (triviaux · clés fausses · explic. incohérentes · doublons · hors cours relevé) |
|---|---|---|---|---|
| Référence : main (2be2074) | mesuré, 1 run | 6,85 | 56 min | 45 % · 2 · 6 · 2 · 5 |
| Référence : it0 (51d2a5d) | mesuré, 3 runs | 7,28 ± 0,32 | 60 min | 44 ± 7 % · 0,7 · 1,7 · 3 · 6 |
| **B** sur-générer puis filtrer (lots de 8 + 15 % de réserve, 1 vérification groupée, 1 réparation, 1 revue) | **retenu**, it2 | 2,79 ± 0,16 | 31 min | 50 ± 15 % · 1,3 · 1,3 · 0 · 12 |
| **B + D** effort « medium » sur la seule vérification à l'aveugle, explications élaguées des options remplacées | **retenu**, it5 (+ it5r rebasé) | 2,26 ± 0,21 (it5r 2,57 ± 0,41) | 20 min | 54 ± 7 % · 0,7 · 1,0 · 0 · 11 |
| D modèles par étape | partiel | ≤ −0,05 $ de plus | = | `claude-sonnet-5-5` et `claude-haiku-5-5` n'existent pas ; Haiku 4.5 sur le second regard hors cours plafonne le gain à 0,05 $ ; l'effort medium sur la revue finale (it3) sur-signale les doublons et relance un comblement : rejeté |
| C contexte du cours compressé et mis en cache | estimé | −0,1 à −0,2 $ au mieux | = | 89 % du coût est de la SORTIE (réflexion surtout) ; l'entrée entière d'un QCM (≈ 148 k tokens) vaut 0,30 $. Le cache simulé est déjà compté. Gain plafonné, pas prioritaire |
| E un seul appel (génération + auto-vérification) | non testé | ≥ 1,2-1,4 $ (borne : coût de la conception seule) | ≈ 8 min | perd la vérification à l'aveugle, seul contrôle qui a trouvé les clés fausses ; la conception seule livre 55-63 % de triviaux avant réparation. Ne tient pas la qualité |
| A banque de questions par cours | estimé | ≈ 0,11 $ par question, payé une fois (≈ 0,06 $ en Message Batches) ; coût marginal d'un QCM ≈ 0 | quelques secondes | celle du moteur B + D, figée à la génération ; demande une garde de fraîcheur (banque épuisée, sources modifiées) et un tirage par poids de notions et faiblesses |

## Lecture

Le gain mesuré vient de B : la boucle « générer, vérifier, régénérer » de main relançait 12 à 21 régénérations complètes et 7 à 10 réparations par QCM ; « sur-générer puis filtrer » ramène le QCM de 51-59 appels à 8-15 et de 7 $ à 2,3-2,6 $, la latence de 56-60 min à 20-26 min. D n'apporte qu'un site rentable (la vérification à l'aveugle, −0,5 $) ; les autres sites décident de la sélection et régressent à effort réduit. C et E sont bornés par la structure du coût : c'est la réflexion en sortie qui coûte, pas le contexte.

La dette qualité de B + D tient aux distracteurs : triviaux 54 % contre 44-45 % pour main et it0. La cause est mesurée : 63 % des triviaux sont du texte de réparation jamais revérifié, et le procédé imposé depuis it2 (« une autre notion décrite par sa vraie caractéristique ») produit des options qui se réfutent en relisant l'énoncé. Le hors cours relevé (11 contre 5-6) est un artefact du juge : il ne lit que les 900 premiers caractères de chaque document du cours, et les mêmes QCM rejugés avec une fenêtre centrée sur le bon passage tombent à 2,0 (it0), 2,0 (main) et 2,8 (it5). Les itérations 6 et suivantes de la boucle visent ces deux points.

## Recommandation

1. **Maintenant** : B + D (PR #106), après correction des triviaux par la boucle. Coût divisé par 3, latence par 2,5-3.
2. **Ensuite, A**, la seule option qui change d'ordre de grandeur : la banque générée par le moteur B + D pendant la préparation du cours (non interactive, donc éligible aux Message Batches à −50 %), servie par tirage. Coût par QCM servi ≈ 0, latence de quelques secondes. Décision produit de Ben : coût payé d'avance par cours (≈ 10-20 $ pour 100-200 questions au tarif API, la moitié en lots), et règles de renouvellement (épuisement, sources modifiées, reprises d'examens précédents).
3. **Pas** de C ni d'E : gain plafonné pour C, qualité perdue pour E.

Les chiffres A et Batches sont des estimations (la mesure en lots demande une clé API, exclue du banc) ; tous les autres sont mesurés.
