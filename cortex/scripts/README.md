# Scripts locaux

## Bancs avec l'abonnement ChatGPT

Le moteur utilise normalement le backend `claude` historique. Pour un banc local ou `eval-gen`, il peut envoyer les mêmes prompts au CLI Codex authentifié par l'abonnement ChatGPT :

```sh
CORTEX_LLM_BACKEND=codex \
CORTEX_DATA_DIR=/chemin/vers/des-donnees-jetables \
npx tsx scripts/eval-gen.ts …
```

Le backend exécute `codex exec` en lecture seule, lit son flux JSONL et récupère uniquement le message final. Quand l'appel Cortex fournit un schéma JSON, il est transmis avec `--output-schema`. Le prompt passe sur l'entrée standard et le délai d'expiration de l'appel reste appliqué. Ce montage suit le mode headless documenté par OpenAI : <https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex>.

Variables optionnelles :

- `CORTEX_CODEX_BIN` : chemin d'un binaire Codex précis (utile pour les tests) ;
- `CORTEX_CODEX_MODEL` : modèle passé à `codex exec`. Sans cette variable, le CLI choisit son modèle configuré.

Garde-fous : ce backend est réservé aux scripts de banc locaux. Il refuse `NODE_ENV=production`, toute `DATABASE_URL` et tout `DB_DRIVER` autre que `sqlite`. Utiliser un `CORTEX_DATA_DIR` jetable pour ne jamais travailler sur les données normales. La production garde le backend historique tant que `CORTEX_LLM_BACKEND=codex` n'est pas posé.
