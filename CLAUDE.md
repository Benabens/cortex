# Cortex — Instructions projet (à lire en premier)

App locale « second cerveau » de révision pour **Computer Systems (CS202)**.
Lis **STATE.md** (journal de bord) et **ROADMAP.md** avant de bosser, puis mets-les à jour + commit après chaque incrément.

## 🚫 RÈGLE ABSOLUE — NE JAMAIS MODIFIER LES SITES DE BASE

Ben travaille **en parallèle** sur ses sites de révision avec un autre outil. Ces fichiers sont
des **SOURCES DE DONNÉES EN LECTURE SEULE** pour l'app — l'app les **indexe**, elle ne les réécrit JAMAIS.

**Interdiction formelle de créer/modifier/supprimer ces fichiers et dossiers** (à la racine du repo) :
- `reviews.html`, `index.html`
- `c_cheatsheet.html`, `cheatsheet_v5_preview.html`, `c_errors_journal.html`
- `exam_packets_R1_table.html`, `final2020_enonce.html`, `lab4_inode_walk.html`
- les dossiers `exercices/`, `cours/`, `labs/`, `notes/`

Si une feature semble demander de toucher à ces fichiers : **arrête-toi et demande**. Ne les édite pas.

Tu peux uniquement travailler dans **`cortex/`** (l'app) et les docs de pilotage (`STATE.md`, `ROADMAP.md`, `ARCHITECTURE.md`, `CLAUDE.md`).

## Moteur IA = Claude Code (toi), via l'abonnement Max — PAS l'API payante

Génération d'examens et analyse de faiblesses passent par **toi** (gratuit via Max), pas par un appel API.
Workflow (cf. ARCHITECTURE.md) :
- Examens : `npm run exam:brief` → tu rédiges un JSON conforme → `npm run exam:save -- <fichier.json>`.
- Faiblesses : `npm run weakness:brief` (liste les « à analyser ») → tu lis les screenshots comme images → tu rédiges → `npm run weakness:save -- <id> <fichier.json>`.

## Lancer l'app (après un clone frais, ex. sur Dispatch)

```
cd cortex
npm install
npm run ingest      # reconstruit la base (data/ n'est pas dans git)
npm run dev         # http://localhost:3000
```
La base SQLite, les uploads et la clé API (`.env.local`) ne sont **pas** dans git — c'est voulu.
La clé API n'est nécessaire QUE si on veut le bouton « générer » instantané in-app (optionnel).

## Garde-fous git
- Jamais commiter `.env.local` ni `cortex/data/` (déjà gitignorés).
- Travailler sur une branche, commiter par incrément, messages clairs.
