/**
 * ROLLBACK DE LA PROD RAILWAY après un smoke raté (.github/workflows/post-deploy.yml).
 *
 *   RAILWAY_TOKEN=… npx tsx scripts/railway-rollback.ts --sha <commit> [--dry-run]
 *
 * Remet en ligne le dernier déploiement sain ANTÉRIEUR au commit fautif — image
 * et variables de ce déploiement, c'est ainsi que Railway fait un rollback. Le
 * jeton est un jeton de PROJET (Project Settings → Tokens), limité à
 * l'environnement de production : il donne lui-même le projet et
 * l'environnement, rien d'autre à configurer. Refuse tout ce qui ressemble à
 * une cascade (rollback d'un rollback, commit déjà remplacé par un déploiement
 * plus récent) : dans le doute, on laisse la prod telle quelle et on le dit.
 *
 * Sortie : 0 = rollback lancé (ou plan affiché en --dry-run), 2 = refusé, 1 = erreur.
 */

const API = "https://backboard.railway.com/graphql/v2";
const SERVICE = process.env.RAILWAY_SERVICE ?? "cortex-app";

export type RailwayDeployment = {
  id: string;
  status: string;
  createdAt: string;
  canRollback: boolean;
  meta?: { commitHash?: string; reason?: string } | null;
};

export type RollbackPlan = { bad?: RailwayDeployment; target?: RailwayDeployment; refusal?: string };

/** Statuts d'un déploiement qui a réellement servi (REMOVED = remplacé par un plus récent). */
const SERVED = new Set(["SUCCESS", "REMOVED"]);

export function pickRollbackTarget(deployments: RailwayDeployment[], badSha: string): RollbackPlan {
  const sorted = [...deployments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const bad = sorted.find((d) => d.meta?.commitHash === badSha);
  if (!bad) return { refusal: `aucun déploiement Railway pour le commit ${badSha.slice(0, 7)}` };
  if (bad.meta?.reason === "rollback") return { bad, refusal: "ce déploiement est déjà un rollback : pas de rollback en cascade" };
  const newer = sorted.find((d) => d.createdAt > bad.createdAt && d.status === "SUCCESS");
  if (newer) return { bad, refusal: `un déploiement plus récent est en ligne (${newer.meta?.commitHash?.slice(0, 7) ?? newer.id}) : rien à annuler` };
  const target = sorted.find((d) => d.createdAt < bad.createdAt && d.canRollback && SERVED.has(d.status) && d.meta?.commitHash !== badSha);
  if (!target) return { bad, refusal: "aucun déploiement antérieur réutilisable" };
  return { bad, target };
}

type Gql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

function client(token: string, fetchImpl: typeof fetch): Gql {
  return async <T>(query: string, variables: Record<string, unknown> = {}) => {
    const r = await fetchImpl(API, {
      method: "POST",
      headers: { "content-type": "application/json", "project-access-token": token },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await r.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message?: string }> };
    if (!r.ok || body.errors?.length || !body.data) {
      throw new Error(`API Railway : HTTP ${r.status} ${body.errors?.map((e) => e.message).join(" ; ") ?? ""}`.trim());
    }
    return body.data;
  };
}

export async function rollback(opts: { token: string; sha: string; dryRun: boolean; fetch?: typeof fetch }): Promise<RollbackPlan & { rolledBack: boolean }> {
  const gql = client(opts.token, opts.fetch ?? fetch);
  const { projectToken } = await gql<{ projectToken: { projectId: string; environmentId: string } }>(
    `query { projectToken { projectId environmentId } }`,
  );
  const { project } = await gql<{ project: { services: { edges: Array<{ node: { id: string; name: string } }> } } }>(
    `query($p: String!) { project(id: $p) { services { edges { node { id name } } } } }`,
    { p: projectToken.projectId },
  );
  const service = project.services.edges.find((e) => e.node.name === SERVICE)?.node;
  if (!service) throw new Error(`service « ${SERVICE} » introuvable dans le projet`);
  const { deployments } = await gql<{ deployments: { edges: Array<{ node: RailwayDeployment }> } }>(
    `query($p: String!, $e: String!, $s: String!) {
      deployments(first: 20, input: { projectId: $p, environmentId: $e, serviceId: $s }) {
        edges { node { id status createdAt canRollback meta } }
      }
    }`,
    { p: projectToken.projectId, e: projectToken.environmentId, s: service.id },
  );
  const plan = pickRollbackTarget(deployments.edges.map((e) => e.node), opts.sha);
  if (plan.refusal || !plan.target || opts.dryRun) return { ...plan, rolledBack: false };
  await gql(`mutation($id: String!) { deploymentRollback(id: $id) }`, { id: plan.target.id });
  return { ...plan, rolledBack: true };
}

async function main(argv: string[]): Promise<number> {
  const sha = argv[argv.indexOf("--sha") + 1] ?? "";
  const dryRun = argv.includes("--dry-run");
  const token = process.env.RAILWAY_TOKEN?.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) { console.error("usage : railway-rollback.ts --sha <commit complet> [--dry-run]"); return 1; }
  if (!token) { console.error("RAILWAY_TOKEN absent : rollback impossible (cortex/scripts/setup-fiabilite.sh le pose)."); return 1; }
  const r = await rollback({ token, sha, dryRun });
  const short = (d?: RailwayDeployment) => (d ? `${d.meta?.commitHash?.slice(0, 7) ?? "?"} (${d.id}, ${d.status})` : "—");
  if (r.refusal) { console.log(`Rollback refusé : ${r.refusal}.`); return 2; }
  console.log(`${dryRun ? "[dry-run] rollback prévu" : "Rollback lancé"} : ${short(r.bad)} → ${short(r.target)}`);
  return 0;
}

if (process.argv[1]?.endsWith("railway-rollback.ts")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); },
  );
}
