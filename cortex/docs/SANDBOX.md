# Sandbox d'exécution — modèle de menace

Cortex exécute du code qu'il n'a pas écrit : expressions passées à sympy (issues
d'une sortie de modèle) et, pour la vérification déterministe des réponses
« écris/corrige une fonction », des programmes C/Python. Tout passe par
`lib/sandbox-exec.ts`. Ce document dit ce qu'on protège, comment, et ce qu'on ne
protège **pas**.

## Ce qu'on défend

| Menace | Défense |
|---|---|
| Exfiltration / rappel réseau (« phone home », lecture d'un endpoint) | **Réseau entièrement coupé** : macOS `sandbox-exec` `(deny network*)` ; Linux `unshare -rn` (namespace réseau vide). Prouvé par test (connexion à 1.1.1.1 → `BLOCKED`). |
| Écriture hors zone jetable (modifier le repo, la DB, `~`) | Écriture **bornée au cwd temporaire** (Seatbelt `deny file-write* (subpath "/")` + `allow` du seul cwd) ; le cwd est un `mkdtemp` supprimé en `finally`. |
| Boucle infinie / consommation CPU | `ulimit -t` (CPU) **et** timeout wall-clock avec `SIGKILL`. Prouvé (boucle infinie tuée < 12 s). |
| Bombe de sortie (Go de stdout) | `maxBuffer` + troncature à 64 Ko. |
| Bombe de fichier (remplir le disque) | `ulimit -f` (128 Mo). |
| Épuisement de descripteurs | `ulimit -n 64`. |
| **Aucune isolation disponible** | **Refus d'exécuter** : `runSandboxed` → `{ok:false, reason:'no-sandbox'}`, `verifyCode` → `not_applicable`. Jamais d'exécution nue. Prouvé (test `CORTEX_SANDBOX=none`). |

## Ce qu'on ne défend PAS (limites assumées)

- **Pas de VM / pas de résistance à un exploit noyau.** Seatbelt et les namespaces
  Linux sont des barrières kernel ; une faille d'évasion du kernel les contourne.
  Acceptable pour notre modèle (code semi-fiable issu d'un LLM, sur la machine du
  développeur ou un runner CI éphémère), inadapté à du code réellement hostile
  d'inconnus sur une machine partagée persistante.
- **Mémoire non bornée dur sur macOS** (`ulimit -v` peu fiable) : on s'appuie sur
  CPU + temps + sortie tronquée. Sur Linux `unshare` on peut ajouter des cgroups
  si besoin (non fait à ce stade).
- **sympy `parse_expr` utilise `eval()` en interne.** L'entrée est nettoyée
  (`sympy_check.py` `clean()` + garde « mathy »), mais la vraie barrière est la
  sandbox : aucun réseau, aucune écriture hors cwd, timeout. C'est pour ça que le
  chemin sympy est désormais routé PAR la sandbox quand elle est disponible.

## Disponibilité par plateforme

- **macOS** : `sandbox-exec` (Seatbelt) — présent en standard. ✅
- **Linux (dont CI GitHub)** : `unshare -rn` — nécessite les user namespaces non
  privilégiés (Ubuntu 23.10+ les restreint ; la CI fait
  `sysctl kernel.apparmor_restrict_unprivileged_userns=0`). ✅
- **Ailleurs / isolation absente** : exécution **refusée** (dégradation sûre :
  la vérification par exécution devient `not_applicable`, jamais un faux
  « prouvé »).

Surcharge de test : `CORTEX_SANDBOX=none` force le mode « aucune isolation ».
Binaire python/gcc : `CORTEX_PYTHON`, `CORTEX_CC`.
