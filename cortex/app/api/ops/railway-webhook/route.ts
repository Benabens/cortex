import { handleRailwayWebhook } from "@/lib/railway-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Webhook Railway (déploiement en échec, planté, OOM, monitor) → mail immédiat au destinataire
 * du bilan. Public dans proxy.ts (Railway ne porte pas de session) : la sécurité est le jeton
 * RAILWAY_WEBHOOK_TOKEN de l'URL. Tout est dans lib/railway-webhook.
 */
export async function POST(req: Request) {
  return handleRailwayWebhook(req);
}
