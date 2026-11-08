# Rapport de charge

Date : 2026-11-08T19:00:44.765Z
Plateforme générateur : darwin 27.0.0
Plage de ports : 49152 65535

| Utilisateurs | Pipeline/connexion | Requêtes | p97,5 (borne conservatrice p95) | Resets réseau | Timeouts | HTTP non-2xx |
|---:|---:|---:|---:|---:|---:|---:|
| 50 | 1 | 12962 | 40 ms | 0 | 0 | 0 |
| 100 | 1 | 10511 | 99 ms | 0 | 0 | 0 |
| 150 | 1 | 12138 | 2304 ms | 1610 | 0 | 0 |
| 200 | 1 | 11380 | 1030 ms | 18258 | 0 | 0 |
| 200 | 10 | 10980 | 539 ms | 62020 | 0 | 0 |

## Parcours utilisateurs réels (auth → cours → génération → OAuth/MCP)

Ces parcours utilisent le pool keep-alive de Node et une montée progressive (20 ms entre utilisateurs).

| Utilisateurs | Réussis | Erreurs | p95 parcours | Exemples |
|---:|---:|---:|---:|---|
| 50 | 50 | 0 | 123 ms | — |
| 200 | 200 | 0 | 164 ms | — |

Santé après charge (avec nouvelle connexion et reprise) : HTTP 200.
Diagnostic : défaillance de la pile réseau du générateur macOS, pas de l’app : seuls ses resets apparaissent ; les parcours keep-alive passent et l’app redevient immédiatement saine. La comparaison Linux CI doit préciser si les ports éphémères sont la cause exacte.

## Métriques avant

```
{"error":"métriques protégées (METRICS_TOKEN requis)"}
```

## Métriques après

```
indisponible
```
