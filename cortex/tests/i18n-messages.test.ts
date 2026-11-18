/**
 * Dictionnaires de l'interface : le français et l'anglais ont exactement les mêmes clés et,
 * pour chaque message, les mêmes arguments ICU ({count}, {name}…). Une clé ajoutée d'un seul
 * côté ou un argument oublié dans la traduction est une chaîne cassée à l'écran.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import en from "../messages/en.json";
import fr from "../messages/fr.json";
import { createTranslator } from "use-intl/core";
import { translator } from "../lib/i18n/translate";

type Tree = { [k: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv);
  }
  return out;
}

/**
 * Noms des arguments ICU d'un message, y compris ceux d'un pluriel ou d'un select. Lecture par
 * accolades : le corps d'une branche (`one {…}`, `name {nom}`) est du texte, pas un argument.
 */
function icuArgs(msg: string): string[] {
  const names = new Set<string>();
  let i = 0;
  const ws = () => { while (/\s/.test(msg[i] ?? "")) i++; };
  const word = () => { const m = /^[=\w]+/.exec(msg.slice(i)); i += m ? m[0].length : 0; return m?.[0] ?? ""; };
  // Texte jusqu'à l'accolade fermante de ce niveau (ou la fin), arguments compris.
  const text = (): void => {
    while (i < msg.length && msg[i] !== "}") {
      if (msg[i] === "{") { i++; arg(); } else i++;
    }
  };
  const arg = (): void => {
    ws(); names.add(word()); ws();
    if (msg[i] === ",") {
      i++; ws(); const type = word(); ws();
      if (["plural", "select", "selectordinal"].includes(type) && msg[i] === ",") {
        i++;
        for (;;) {
          ws();
          if (msg[i] !== "}" && word() === "offset" && msg[i] === ":") { i++; ws(); word(); continue; }
          ws();
          if (msg[i] !== "{") break;
          i++; text(); i++; // corps de la branche
        }
      } else while (i < msg.length && msg[i] !== "}") i++; // {n, number, …}
    }
    i++; // accolade fermante de l'argument
  };
  text();
  // Balises riches <b>…</b> : même jeu des deux côtés.
  for (const m of msg.matchAll(/<([A-Za-z][\w]*)>/g)) names.add(`<${m[1]}>`);
  return [...names].sort();
}

const FR = flatten(fr as Tree);
const EN = flatten(en as Tree);

test("mêmes clés en français et en anglais", () => {
  const onlyFr = [...FR.keys()].filter((k) => !EN.has(k));
  const onlyEn = [...EN.keys()].filter((k) => !FR.has(k));
  assert.deepEqual(onlyFr, [], "clés sans traduction anglaise");
  assert.deepEqual(onlyEn, [], "clés anglaises sans original français");
});

test("lecture des arguments : corps de branche ignoré, argument imbriqué vu", () => {
  assert.deepEqual(icuArgs("{field, select, name {nom} code {code} other {{field}}}"), ["field"]);
  assert.deepEqual(icuArgs("{count, plural, offset:1 =0 {aucun} one {# de {name}} other {#}} <b>{n, number}</b>"), ["<b>", "count", "n", "name"]);
});

test("mêmes arguments ICU des deux côtés, aucun message vide", () => {
  const broken: string[] = [];
  for (const [k, v] of FR) {
    if (!v.trim() || !EN.get(k)?.trim()) broken.push(`${k} : vide`);
    else if (icuArgs(v).join() !== icuArgs(EN.get(k)!).join()) broken.push(`${k} : ${icuArgs(v)} ≠ ${icuArgs(EN.get(k)!)}`);
  }
  assert.deepEqual(broken, []);
});

test("chaque message se formate dans les deux langues (ICU valide)", () => {
  const errors: string[] = [];
  for (const locale of ["fr", "en"] as const) {
    const t = createTranslator({
      locale, messages: locale === "fr" ? fr : en, timeZone: "Europe/Zurich",
      onError: (e) => errors.push(`${locale} : ${e.message}`),
    }) as unknown as (k: string, v?: Record<string, unknown>) => string;
    for (const [k, msg] of locale === "fr" ? FR : EN) {
      const values = Object.fromEntries(icuArgs(msg).map((a) =>
        a.startsWith("<") ? [a.slice(1, -1), (chunks: string[]) => chunks.join("")] : [a, 2]));
      t(k, values);
    }
  }
  assert.deepEqual(errors, []);
});

test("le traducteur hors React rend la langue demandée", () => {
  assert.equal(translator("fr")("locale.title"), "Langue");
  assert.equal(translator("en")("locale.title"), "Language");
});
