-- Coût RÉEL des générations en prod, lu dans public.llm_usage (audit du 13/11/2026, Y1).
-- LECTURE SEULE garantie : transaction READ ONLY, aucune fonction applicative
-- (npm run cost:report passe par la couche Cortex, qui amorce le tenant en écrivant).
-- Lancé par scripts/cout-reel-ben.sh, qui fournit :eur (€ par $), :credit_pack et
-- :credit_abo (€ nets encaissés par crédit).
\set ON_ERROR_STOP on
\pset footer off
SET default_transaction_read_only = on;
BEGIN READ ONLY;

\echo
\echo '== 1. Dépense par mois et par modèle (estimes = tokens estimés, pas lus dans la réponse API)'
SELECT substr(created_at, 1, 7) AS mois, provider, model, count(*) AS appels,
       sum(estimated) AS estimes, round(sum(cost_usd)::numeric, 2) AS usd
FROM public.llm_usage
GROUP BY 1, 2, 3
ORDER BY 1, 6 DESC;

\echo
\echo '== 2. Coût moyen par type de génération, face au prix en crédits (lib/billing/credits.ts:61-72)'
WITH prix(type, credits) AS (
  VALUES ('exam', 2.0), ('qcm', 1.0), ('exercise', 1.0), ('lab-exercise', 1.0),
         ('blueprint', 1.0), ('format', 1.0), ('prepare', 2.0)
), jobs AS (
  SELECT user_id, course, job_id, split_part(call_site, ':', 1) AS type,
         count(*) AS appels, sum(estimated) AS estimes,
         sum(coalesce(tokens_in, 0)) AS t_in, sum(coalesce(tokens_out, 0)) AS t_out,
         sum(coalesce(cache_read, 0)) AS c_read, sum(cost_usd) AS usd
  FROM public.llm_usage
  WHERE job_id IS NOT NULL AND call_site LIKE '%:%'
  GROUP BY 1, 2, 3, 4
)
SELECT j.type, count(*) AS jobs, round(avg(j.appels), 1) AS appels_moy, sum(j.estimes) AS appels_estimes,
       round(avg(j.t_in)) AS tok_in_moy, round(avg(j.t_out)) AS tok_out_moy, round(avg(j.c_read)) AS cache_lu_moy,
       round(avg(j.usd)::numeric, 3) AS usd_moy, round(max(j.usd)::numeric, 3) AS usd_max,
       round((avg(j.usd) * :eur)::numeric, 2) AS cout_eur_moy,
       p.credits,
       round(p.credits * :credit_pack, 2) AS recette_pack_eur,
       round(p.credits * :credit_abo, 2) AS recette_abo_eur,
       round((100 * (p.credits * :credit_abo - avg(j.usd) * :eur) / nullif(p.credits * :credit_abo, 0))::numeric) AS marge_abo_pct
FROM jobs j LEFT JOIN prix p USING (type)
GROUP BY j.type, p.credits
ORDER BY usd_moy DESC;

\echo
\echo '== 3. Les 15 derniers jobs (le détail derrière les moyennes)'
SELECT min(created_at) AS debut, course, job_id, split_part(call_site, ':', 1) AS type,
       count(*) AS appels, sum(estimated) AS estimes,
       sum(coalesce(tokens_in, 0)) AS t_in, sum(coalesce(tokens_out, 0)) AS t_out,
       round(sum(cost_usd)::numeric, 3) AS usd,
       round((sum(latency_ms) / 1000.0)::numeric) AS secondes_llm
FROM public.llm_usage
WHERE job_id IS NOT NULL
GROUP BY course, job_id, split_part(call_site, ':', 1)
ORDER BY debut DESC
LIMIT 15;

\echo
\echo '== 4. Appels interactifs hors job (question, correction, faiblesses) : facturés 0,1 crédit'
SELECT call_site, count(*) AS appels, round(avg(cost_usd)::numeric, 4) AS usd_moy,
       round(max(cost_usd)::numeric, 4) AS usd_max,
       round((avg(cost_usd) * :eur)::numeric, 3) AS cout_eur_moy,
       round(0.1 * :credit_abo, 3) AS recette_abo_eur
FROM public.llm_usage
WHERE job_id IS NULL
GROUP BY call_site
ORDER BY usd_moy DESC;

COMMIT;
