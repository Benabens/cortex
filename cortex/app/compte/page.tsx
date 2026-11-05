import { auth, authEnabled } from "@/lib/auth";
import { mcpEnabled } from "@/lib/oauth/config";
import { AccountContent } from "./AccountContent";

export const dynamic = "force-dynamic";

export default async function ComptePage() {
  const enabled = authEnabled();
  const session = enabled ? await auth() : null;
  return <AccountContent email={session?.user?.email ?? null} enabled={enabled} connectedAppsEnabled={mcpEnabled()} />;
}
