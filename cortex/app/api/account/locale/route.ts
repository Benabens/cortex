import { NextRequest, NextResponse } from "next/server";
import { setAccountLocale } from "@/lib/i18n/account-locale";
import { isLocale, LOCALE_COOKIE } from "@/lib/i18n/locale";
import { readJson, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Choix de langue depuis /compte : enregistré sur le compte (e-mails, MCP, autres
 * appareils) et posé en cookie pour la requête suivante. Sans session (instance sans
 * auth), seul le cookie porte le choix : il n'y a pas de compte où l'écrire.
 */
export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const body = ((await readJson(req, {})) ?? {}) as { locale?: unknown };
  if (!isLocale(body.locale)) {
    return NextResponse.json({ error: "Langue non disponible.", code: "locale_unsupported" }, { status: 400 });
  }
  const userId = req.headers.get("x-cortex-user");
  if (userId) await setAccountLocale(userId, body.locale);
  const res = NextResponse.json({ ok: true, locale: body.locale });
  res.cookies.set(LOCALE_COOKIE, body.locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  return res;
});
