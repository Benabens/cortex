# Routine nocturne Cortex (exécutée par Claude Code planifié, via Max — 0 € API)

But : chaque nuit, analyser les faiblesses en attente et générer un examen frais ciblé,
puis tout commiter pour que Ben le retrouve au réveil (Mac + téléphone).

**Respecter CLAUDE.md** : ne JAMAIS modifier les sites de base. Travailler dans `cortex/` uniquement.

## Étapes

```bash
cd cortex
npm install                 # construit les deps (better-sqlite3, etc.)
# (ingest seulement si les sites de base ont changé : npm run ingest)
```

1. **Analyser les faiblesses en attente**
   - `npm run weakness:brief` → liste les faiblesses `à analyser` (avec chemin du screenshot).
   - Pour chacune : LIRE le screenshot comme image (outil Read), comprendre l'exo, rédiger
     un JSON `{ "topic", "concepts": [...], "explanation" }`, puis
     `npm run weakness:save -- <id> /tmp/w<id>.json`.

2. **Générer un examen frais**
   - `npm run exam:brief` → lire le contexte (faiblesses + concepts dus + format des 2 examens
     récents + matière).
   - Rédiger un examen au schéma `ExamSpec` `{ "title", "questions": [...] }` qui :
     - reproduit la FORME CONCRÈTE des 2 examens récents (structure, types de questions,
       schémas/tableaux recréés en HTML/ASCII) **sans recopier** ;
     - cible en priorité les faiblesses + couvre les concepts dus ;
     - corrigés détaillés étape par étape.
   - `npm run exam:save -- /tmp/exam.json`.

3. **Figer la base puis pousser**
   ```bash
   npm run db:checkpoint
   cd ..
   git add -A
   git commit -m "Nightly: examen + analyses du <date>"
   git push
   ```

4. Mettre à jour `STATE.md` (1-2 lignes : ce qui a été généré).

## Notes
- La base SQLite (`cortex/data/cortex.db`) + uploads + exams sont commités → synchro multi-appareils.
- La clé API n'est PAS nécessaire (le moteur, c'est Claude Code). `.env.local` reste hors git.
