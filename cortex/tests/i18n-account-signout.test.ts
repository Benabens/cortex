/**
 * Bouton "Se déconnecter" de /compte (sous "Connecté en tant que") : présent, dans les
 * deux langues, et appelle bien `signOut` de next-auth/react plutôt que la page NextAuth
 * par défaut (/api/auth/signout) — vérifié ici au niveau du code source du composant.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createElement } from "react";
import { test } from "node:test";
import { AccountSignOut } from "../app/compte/AccountSignOut";
import { renderIntl } from "./helpers/intl";

test("le bouton de déconnexion de /compte est présent et traduit en français et en anglais", () => {
  const fr = renderIntl(createElement(AccountSignOut), "fr");
  const en = renderIntl(createElement(AccountSignOut), "en");
  assert.match(fr, /<button[^>]*>Se déconnecter<\/button>/);
  assert.match(en, /<button[^>]*>Sign out<\/button>/);
});

test("le bouton appelle signOut({ callbackUrl: \"/login\" }), pas la page NextAuth par défaut", () => {
  const src = fs.readFileSync("app/compte/AccountSignOut.tsx", "utf8");
  assert.match(src, /import \{ signOut \} from "next-auth\/react"/);
  assert.match(src, /signOut\(\{\s*callbackUrl:\s*"\/login"\s*\}\)/);
});
