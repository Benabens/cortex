/**
 * GARDES DE DÉMARRAGE (appelées par scripts/prod-boot.ts avant `next start`).
 *
 * Sans AUTH_ENABLED=1, le proxy laisse tout passer et chaque visiteur est
 * « owner » : c'est le mode dev mono-user. Oublier la variable sur une vraie
 * mise en ligne ouvrirait les données de l'instance à tout Internet, et une
 * instance qui encaisse (BILLING_ENABLED=1) sans identité ne peut créditer
 * personne. On refuse donc de démarrer plutôt que de le découvrir en prod.
 */
export function assertAuthRequired(env: Partial<NodeJS.ProcessEnv> = process.env): void {
  const authOn = env.AUTH_ENABLED === "1";
  if (authOn) return;
  const reasons: string[] = [];
  if (env.NODE_ENV === "production") reasons.push("NODE_ENV=production");
  if (env.BILLING_ENABLED === "1") reasons.push("BILLING_ENABLED=1");
  if (!reasons.length) return;
  throw new Error(
    `Configuration dangereuse : ${reasons.join(" et ")} sans AUTH_ENABLED=1. ` +
    "Sans authentification, chaque visiteur serait « owner » et verrait toutes les données. " +
    "Pose AUTH_ENABLED=1 (avec AUTH_SECRET, DB_DRIVER=postgres) — ou retire NODE_ENV/BILLING_ENABLED " +
    "pour une instance de développement locale."
  );
}

const hostOf = (url: string | undefined): string => {
  try { return new URL(url ?? "").hostname; } catch { return ""; }
};
const LOOPBACK = ["localhost", "127.0.0.1", "::1"];

/** Nom donné par Railway aux environnements éphémères de PR (« cortex-pr-66 »). */
const PR_ENVIRONMENT = /(?:^|-)pr-\d+$/i;

/**
 * PREVIEW PAR PR. Railway crée l'environnement d'une PR en COPIANT les
 * variables de la prod : clé du vrai modèle, Resend, sauvegardes S3, secret de
 * session. scripts/preview-entrypoint.sh (démarrage propre aux PR, railway.json)
 * les neutralise ; on vérifie ici le résultat, sans le croire sur parole. Rend
 * les raisons pour lesquelles l'instance n'est PAS une preview assainie
 * ([] = c'en est une). Chaque critère ferme une fuite précise :
 * - nom d'environnement de PR, jamais « production » ;
 * - AUTH_URL = domaine Railway de la preview (pas app.cortexexam.com) ;
 * - AUTH_SECRET régénéré au démarrage (« preview-… ») : une session signée
 *   dans la preview ne vaut rien en prod ;
 * - Postgres joint par le réseau PRIVÉ, cloisonné par environnement chez
 *   Railway : c'est forcément la base vierge de la preview ;
 * - LLM hermétique en bouclage (/api/e2e-llm), jamais un modèle payant ;
 * - ni e-mails réels ni sauvegardes vers le vrai bucket.
 */
export function railwayPreviewViolations(env: Partial<NodeJS.ProcessEnv> = process.env): string[] {
  const why: string[] = [];
  const name = env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || "";
  if (name === "production" || !PR_ENVIRONMENT.test(name)) why.push(`environnement « ${name || "inconnu"} » qui n'est pas une preview de PR`);
  if (env.CORTEX_PREVIEW !== "1") why.push("CORTEX_PREVIEW=1 absent");
  if (env.CORTEX_HOSTED === "1") why.push("CORTEX_HOSTED=1 (hébergement hors Railway)");
  const domain = env.RAILWAY_PUBLIC_DOMAIN ?? "";
  if (!domain.endsWith(".up.railway.app") || hostOf(env.AUTH_URL) !== domain) why.push("AUTH_URL ≠ domaine Railway de la preview");
  if (!env.AUTH_SECRET?.startsWith("preview-")) why.push("AUTH_SECRET non régénéré pour la preview");
  if (env.DB_DRIVER === "postgres" && !hostOf(env.DATABASE_URL).endsWith(".railway.internal")) why.push("base hors du réseau privé de la preview");
  let llm: URL | null = null;
  try { llm = new URL(env.LLM_BASE_URL ?? ""); } catch { llm = null; }
  if (env.LLM_PROVIDER !== "openai-compatible" || !llm || !LOOPBACK.includes(llm.hostname) || llm.pathname !== "/api/e2e-llm") {
    why.push("LLM non hermétique");
  }
  if (env.RESEND_API_KEY) why.push("RESEND_API_KEY posé (e-mails réels)");
  if (env.BACKUP_S3_BUCKET) why.push("BACKUP_S3_BUCKET posé (sauvegardes vers le vrai bucket)");
  return why;
}

const hostedInstance = (env: Partial<NodeJS.ProcessEnv>): boolean =>
  Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_PROJECT_ID) || env.CORTEX_HOSTED === "1";

/** Auth par persona : banc E2E local, ou preview de PR Railway assainie. Le
 * second drapeau évite qu'une variable copiée seule dans Railway transforme
 * l'instance en porte dérobée ; en production, le refus est inconditionnel. */
export function assertE2ETestAuthAllowed(env: Partial<NodeJS.ProcessEnv> = process.env): void {
  if (env.E2E_TEST_AUTH !== "1") return;
  if (env.E2E_TEST_RUN !== "1") throw new Error("E2E_TEST_AUTH=1 exige E2E_TEST_RUN=1 (banc local explicite).");
  if (env.STRIPE_SECRET_KEY?.startsWith("sk_live_")) throw new Error("E2E_TEST_AUTH est interdit avec une clé Stripe live.");
  if (hostedInstance(env)) {
    const why = railwayPreviewViolations(env);
    if (why.length) throw new Error(`E2E_TEST_AUTH est interdit sur une instance hébergée hors preview de PR assainie : ${why.join(" ; ")}.`);
    return;
  }
  if (!LOOPBACK.includes(hostOf(env.AUTH_URL))) throw new Error("E2E_TEST_AUTH exige une AUTH_URL de bouclage local (localhost/127.0.0.1).");
  const realPg = env.DB_DRIVER === "postgres" && !!env.DATABASE_URL && !env.DATABASE_URL.startsWith("pglite://");
  if (realPg && env.E2E_ALLOW_LOCAL_POSTGRES !== "1") throw new Error("E2E_TEST_AUTH avec Postgres exige E2E_ALLOW_LOCAL_POSTGRES=1.");
}

/**
 * Variante pour le SERVEUR Next (instrumentation.register) : `next start` force
 * NODE_ENV=production en interne, même sur un poste de dev ou dans le smoke
 * test de la CI — ce signal ne veut donc rien dire là. On refuse de servir si
 * l'instance ENCAISSE (BILLING_ENABLED=1) ou si elle tourne manifestement chez
 * l'hébergeur (variables posées par Railway, ou CORTEX_HOSTED=1) sans
 * AUTH_ENABLED=1. prod-boot (entrypoint Docker) garde en plus le critère
 * NODE_ENV, posé explicitement par l'image.
 */
export function assertAuthRequiredHosted(env: Partial<NodeJS.ProcessEnv> = process.env): void {
  if (env.AUTH_ENABLED === "1") return;
  const reasons: string[] = [];
  if (env.BILLING_ENABLED === "1") reasons.push("BILLING_ENABLED=1");
  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.CORTEX_HOSTED === "1") reasons.push("instance hébergée (Railway / CORTEX_HOSTED=1)");
  // `next start` direct sur un VPS : NODE_ENV=production ne prouve rien seul
  // (Next le force), mais associé à une VRAIE base Postgres (pas PGlite, pas
  // sqlite) c'est une mise en ligne, pas un poste de dev ni le smoke test CI.
  const realPg = env.DB_DRIVER === "postgres" && !!env.DATABASE_URL && !env.DATABASE_URL.startsWith("pglite://");
  if (env.NODE_ENV === "production" && realPg) reasons.push("NODE_ENV=production avec une base Postgres");
  if (!reasons.length) return;
  throw new Error(
    `Configuration dangereuse : ${reasons.join(" et ")} sans AUTH_ENABLED=1. ` +
    "Sans authentification, chaque visiteur serait « owner » et verrait toutes les données. " +
    "Pose AUTH_ENABLED=1 (avec AUTH_SECRET, DB_DRIVER=postgres)."
  );
}

/**
 * DÉPLOIEMENT GARDÉ = instance qui sert d'autres gens que son propriétaire ou
 * qui encaisse : AUTH_ENABLED=1, BILLING_ENABLED=1, hébergeur (Railway) ou
 * CORTEX_HOSTED=1. Les gardes « fail-closed » ne s'appliquent que là.
 */
export function isGuardedDeployment(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return env.AUTH_ENABLED === "1" || env.BILLING_ENABLED === "1" ||
    Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID) || env.CORTEX_HOSTED === "1";
}

/**
 * Le provider `claude-code` (CLI local, défaut quand LLM_PROVIDER est absent)
 * facture 0 (session personnelle du propriétaire) et donne au modèle un outil
 * Read sur le dépôt : sur une instance multi-utilisateurs, hébergée ou
 * facturée, chaque visiteur consommerait l'abonnement du propriétaire et
 * pourrait faire lire n'importe quel fichier. Refus au boot, sauf
 * CORTEX_OWNER_ONLY=1 (instance que son propriétaire est seul à utiliser).
 */
export function assertLlmProviderAllowed(env: Partial<NodeJS.ProcessEnv> = process.env): void {
  const provider = env.LLM_PROVIDER || "claude-code";
  if (provider !== "claude-code") return;
  if (!isGuardedDeployment(env) || env.CORTEX_OWNER_ONLY === "1") return;
  throw new Error(
    "Configuration dangereuse : LLM_PROVIDER=claude-code (CLI local, coût 0, outil Read sur le dépôt) sur une instance " +
    "multi-utilisateurs, hébergée ou facturée. Pose LLM_PROVIDER=anthropic (ou openai-compatible) avec LLM_API_KEY — " +
    "ou CORTEX_OWNER_ONLY=1 si tu es vraiment le seul utilisateur de cette instance."
  );
}

/**
 * OUTILS DE DÉVELOPPEMENT exposés par une route (ici la génération « dry-run » :
 * un examen factice écrit en base et compilé, sans appel au modèle). Ils
 * contournent par nature la réservation de crédits, le quota et les places : ils
 * n'ont donc rien à faire sur une instance gardée, où n'importe quel compte
 * invité pourrait boucler dessus (audit de pré-lancement, bloquant n° 1).
 * Autorisés hors déploiement gardé (poste de dev) ou, sur une instance assumée
 * mono-utilisateur (CORTEX_OWNER_ONLY=1), pour son propriétaire seul.
 */
export async function dryRunAllowed(env: Partial<NodeJS.ProcessEnv> = process.env, userId = ""): Promise<boolean> {
  if (env.E2E_TEST_AUTH === "1" && env.E2E_TEST_RUN === "1" && (!hostedInstance(env) || railwayPreviewViolations(env).length === 0)) return true;
  if (!isGuardedDeployment(env)) return true;
  if (env.CORTEX_OWNER_ONLY !== "1") return false;
  // Même notion de propriétaire que partout ailleurs (identifiant explicite,
  // sinon e-mail, sinon le compte mono-utilisateur de dev) : deux définitions
  // concurrentes finissaient par refuser l'outil au propriétaire lui-même.
  const { isOwnerAccount } = await import("@/lib/account-deletion");
  return await isOwnerAccount(userId, env);
}
