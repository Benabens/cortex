/**
 * Menu de compte du Topbar (déclencheur icône, haut à droite) : rôle/état ARIA corrects et
 * libellé traduit, fermé par défaut. Le clic qui ouvre le menu et déconnecte réellement est
 * couvert par e2e/sign-out.spec.ts (interaction, pas disponible en rendu statique).
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { test } from "node:test";
import { AccountMenu } from "../components/shell/AccountMenu";
import { renderIntl } from "./helpers/intl";

test("le déclencheur du menu de compte est fermé par défaut, avec les bons attributs ARIA", () => {
  const fr = renderIntl(createElement(AccountMenu), "fr");
  const en = renderIntl(createElement(AccountMenu), "en");
  for (const html of [fr, en]) {
    assert.match(html, /aria-haspopup="true"/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /aria-controls="account-menu-panel"/);
  }
  assert.match(fr, /aria-label="Mon compte"/);
  assert.match(en, /aria-label="My account"/);
  // Fermé par défaut : le panneau ("Se déconnecter") n'est pas dans le DOM.
  assert.doesNotMatch(fr, /Se déconnecter/);
  assert.doesNotMatch(en, /Sign out/);
});
