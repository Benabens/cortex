# Banc du moteur

Mesure la génération d'examens sur des cas fixes (un cours restauré + une demande), avec des seuils : un seuil franchi est un échec. But : améliorer le moteur pour tous les cours, preuves à l'appui, pas examen par examen.

## Lancer

```sh
LLM_PROVIDER=claude-code \
CORTEX_BENCH_HOME=~/Projects/cortex/contenu-prive/bench \
CORTEX_BENCH_PG_URL=postgres://cortex@127.0.0.1:55433/postgres \
CORTEX_BENCH_CASES=~/Projects/cortex/contenu-prive/bench/cases.json \
npm run bench -- run --case rs-qcm15
```

- `list` : les cas. `run --case <id>` : un run complet (préparation ou instantané, génération, juge, métriques, seuils). Options : `--ref <dossier d'un run>` (compare le coût), `--prepare` (refait la préparation au lieu de l'instantané), `--keep` (garde la base), `--no-judge`, `--replay <dossier>` (rejoue des bandes, sans modèle).
- `mark-ref --run <dossier>` : ce run devient la référence de son cas. `report [--out f.md]` : tableau référence → actuel de tous les cas.
- Postgres local jetable : `LC_ALL=C initdb -D <dir> -U cortex --auth=trust --locale=C`, puis `port`, `listen_addresses = 'localhost'` et `unix_socket_directories = ''` dans `postgresql.conf`. Chaque run crée sa base et la supprime à la fin.

**Jamais l'API payante** (décision du 04/11/2026) : le banc refuse de démarrer si `LLM_PROVIDER` n'est pas `claude-code` ou si `ANTHROPIC_API_KEY`, `LLM_API_KEY` ou `ANTHROPIC_AUTH_TOKEN` est chargée. Il refuse aussi une `DATABASE_URL` qui ne vise pas l'hôte local.

## Cas

Les cas synthétiques (`lib/bench/cases.ts`, domaine inventé de `lib/bench/synth.ts`) sont dans le dépôt. Les cas de vrais cours (RS / CS-290, HUM-285, CS-202) sont décrits dans `CORTEX_BENCH_CASES`, hors du dépôt, avec la même forme. Aucun contenu de cours ni dump n'entre dans git. Un cours préparé depuis ses supports est gardé en instantané (`CORTEX_BENCH_HOME/snapshots`) et restauré aux runs suivants.

## Ce qui est mesuré, et comment

| Famille | Source | Mesuré / estimé |
|---|---|---|
| Livraison, remboursement | base du run (job, `credit_transactions`) | mesuré |
| Couverture par chapitre | plan du cours (à défaut : un chapitre par support hors annales, comme `lib/coverage`), chapitre donné par le juge | mesuré + juge |
| Doublons, fidélité, distracteurs, hors cours | juge à l'aveugle (`lib/bench/judge`) ; code exécuté en bac à sable | juge |
| Rendu | PDF énoncé et corrigé (pages, texte), page en ligne (`getQcmExam` / `getBlockExam`) | mesuré |
| Durées, appels, réessais | journal du job, bande LLM, `llm_usage` | mesuré sur claude-code |
| Tokens d'entrée, cache de prompt, coût $ | taille des prompts (≈ 4 car./token), tarif API, cache = même système dans les 5 min | **estimé, non mesuré** |
| UX | relevés toutes les 2 s : avancement et temps restant affichés | mesuré |

Écarts connus entre providers : claude-code ignore la sortie structurée (`json`), donc plus de redemandes JSON (comptées à part) ; il est plus lent que l'API (lancement du CLI à chaque appel) ; il charge la configuration Claude Code de la machine. Les durées mesurées ici sont donc un majorant de la prod.

## Seuils (`lib/bench/thresholds.ts`)

Livraison 100 % hors panne du fournisseur ; aucun chapitre à 0 dès 10 questions, lu comme « chapitres à 0 ≤ max(0, chapitres − questions) », sans objet pour un focus ; 0 doublon ; ≥ 98 % de clés justes ; 0 explication incohérente ; ≤ 5 % de distracteurs triviaux ; faux rejets hors cours ≤ 3 % ; 100 % des PDF compilés ; 15 QCM < 8 min ; 20 QCM + 3 ouvertes < 12 min ; erreur médiane du temps restant ≤ 25 % (un « en retard » compte 100 %) ; coût au plus +5 % sur la référence.

## Juge

Rubrique figée et versionnée (`lib/bench/rubric.ts`, empreinte épinglée dans `tests/bench-rubric.test.ts`) : la changer impose une nouvelle version, et deux runs ne se comparent que sous la même. Le juge tourne dans un processus à part, en Opus, alors que le moteur tourne en Sonnet comme en prod. Chaque run sort `calibration.md` (10 % des questions, à noter à la main) et `calibration-juge.json` (l'avis du juge sur ces questions, à comparer ensuite).

## CI

`tests/bench-replay.test.ts` rejoue le cas `synth-3p` depuis ses bandes (`tests/fixtures/bench/synth-3p`) : préparation, génération et juge, sans modèle, puis seuils. Un prompt modifié reçoit la réponse du même rang au même site d'appel ; un site absent de la bande échoue. Réenregistrer la bande : `npm run bench -- run --case synth-3p`, puis copier `prepare.tape.jsonl`, `run.tape.jsonl` et `judge.tape.jsonl` du run dans le dossier des fixtures.
