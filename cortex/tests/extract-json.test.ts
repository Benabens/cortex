/**
 * EXTRACTION JSON des réponses de modèle (lib/llm/json, réexportée par lib/llm).
 *
 * Cas de prod du 01/11 (CS-290, notebooks pandas) : un énoncé contenant un bloc
 * ```python dans une réponse enveloppée de ```json faisait capturer le bloc de
 * code INTÉRIEUR par l'ancienne regex → « Unterminated string in JSON at
 * position 120 » ou « Expected ',' or ']' after array element », et tous les
 * lots QCM d'un examen échouaient. Les cas qui marchaient déjà restent verts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractJson, JsonOutputError } from "../lib/llm/json";

const BT = "```";
const CODE_STEM = `Considérez le code suivant :\n${BT}python\nimport pandas as pd\ndf = pd.read_csv("data.csv")\nprint(df.groupby("sex")["income"].mean())\n${BT}\nQue renvoie-t-il ?`;
const qcm = (stem: string) => ({ topic: "pandas", type: "scq", stem, options: ["a", "b", "c", "d"], correct: [1] });

test("une réponse ```json dont un énoncé contient un bloc ```python est lue en entier", () => {
  const payload = { items: [qcm(CODE_STEM), qcm("Q2")] };
  const text = `${BT}json\n${JSON.stringify(payload, null, 2)}\n${BT}`;
  assert.deepEqual(extractJson(text), payload);
});

test("le bloc de code peut être dans le 2ᵉ item (ancien « Expected ',' or ']' »)", () => {
  const payload = { items: [qcm("Q1"), qcm(CODE_STEM)] };
  assert.deepEqual(extractJson(`${BT}json\n${JSON.stringify(payload, null, 2)}\n${BT}`), payload);
});

test("objet nu dont un énoncé contient un bloc de code markdown", () => {
  const payload = { items: [qcm(CODE_STEM)] };
  assert.deepEqual(extractJson(JSON.stringify(payload)), payload);
});

test("tableau JSON à la racine, même avec des accolades dans les chaînes", () => {
  const payload = [{ a: 1 }, { b: "} et {" }];
  assert.deepEqual(extractJson(JSON.stringify(payload)), payload);
  assert.deepEqual(extractJson(`Voici la liste :\n${BT}json\n${JSON.stringify(payload)}\n${BT}`), payload);
});

test("texte avant et après, accolades et crochets dans la prose", () => {
  const payload = { verdict: "correct", feedback: "Bien vu {sic}." };
  const text = `Selon [1], voici ma correction {brève} :\n${JSON.stringify(payload)}\nBonne révision ! (cf. {annexe})`;
  assert.deepEqual(extractJson(text), payload);
});

test("LaTeX, antislashs et guillemets échappés dans les chaînes", () => {
  const payload = { stem: "Calculez $\\frac{a}{b}$ quand \"x\" vaut 1, puis \\(\\sum_i x_i\\).", path: "C:\\data\\x" };
  assert.deepEqual(extractJson(`${BT}json\n${JSON.stringify(payload)}\n${BT}`), payload);
});

test("cas historiques : bloc ```json avec prose autour, bloc sans langue, virgules traînantes", () => {
  assert.deepEqual(extractJson(`Voici :\n${BT}json\n{"a": 1}\n${BT}\nFin.`), { a: 1 });
  assert.deepEqual(extractJson(`${BT}\n{"a": [1, 2]}\n${BT}`), { a: [1, 2] });
  assert.deepEqual(extractJson(`{"a": [1, 2,], "b": {"c": 3,},}`), { a: [1, 2], b: { c: 3 } });
  assert.deepEqual(extractJson(`  {"ok": true}  `), { ok: true });
});

test("deux blocs : le JSON d'abord, du code ensuite", () => {
  const text = `${BT}json\n{"items": [{"stem": "x"}]}\n${BT}\n\nExemple :\n${BT}python\nprint("}")\n${BT}`;
  assert.deepEqual(extractJson(text), { items: [{ stem: "x" }] });
});

test("réparation en dernier recours : retours à la ligne bruts et guillemets non échappés dans une chaîne", () => {
  const raw = `{"items": [{"stem": "Que vaut\ndf.shape ?", "explanation": "La colonne "income" est numérique."}]}`;
  const r = extractJson<{ items: { stem: string; explanation: string }[] }>(raw);
  assert.equal(r.items[0].stem, "Que vaut\ndf.shape ?");
  assert.match(r.items[0].explanation, /income/);
});

test("une réponse tronquée n'est JAMAIS « réparée » en objet partiel", () => {
  const full = JSON.stringify({ items: [qcm("Q1"), qcm("Q2")] });
  const cut = full.slice(0, full.length - 40);
  assert.throws(() => extractJson(cut), (e: unknown) => e instanceof JsonOutputError && /tronqu/i.test(e.message));
});

test("aucun JSON : erreur explicite, code BAD_OUTPUT", () => {
  for (const text of ["", "Je ne peux pas répondre à cette question.", "```python\nprint(1)\n```"]) {
    assert.throws(() => extractJson(text), (e: unknown) => e instanceof JsonOutputError && e.code === "BAD_OUTPUT");
  }
});
