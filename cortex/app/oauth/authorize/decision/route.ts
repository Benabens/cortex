import { NextRequest } from "next/server";
import { consentDecisionEndpoint } from "@/lib/oauth/routes";
import { useUser } from "@/lib/req";
import { withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Accepter / refuser la connexion d'une application au compte (écran /oauth/authorize). */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  return consentDecisionEndpoint(req, useUser(req));
});
