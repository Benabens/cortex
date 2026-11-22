/**
 * Rendu texte des énoncés et corrigés générés (lib/mcp/content : htmlToText, clip), tel que
 * l'assistant le lit dans get_job_status. Le modèle écrit du HTML simple, mais aussi des
 * comparaisons (« flow=1 < 2 »), des entités (&rarr;) et des tableaux de trace.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, htmlToText } from "../lib/mcp/content";

test("un « < » de comparaison ne mange pas la suite (drill Max-flow)", () => {
  const html = "<ol><li>Chemin s→a→t : flow=1 < 2, on augmente.</li><li>Résultat : le flot max vaut 3 > 2.</li></ol>";
  const text = htmlToText(html);
  assert.match(text, /flow=1 < 2, on augmente\./);
  assert.match(text, /le flot max vaut 3 > 2\./);
});

test("« < » collé à une lettre ou à un chiffre reste du texte", () => {
  assert.equal(htmlToText("<p>for (i=0; i<n; i++) si a<b et b>c</p>"), "for (i=0; i<n; i++) si a<b et b>c");
  assert.equal(htmlToText("<p>x<2 ou y<=3, et p<q></p>"), "x<2 ou y<=3, et p<q>");
  assert.equal(htmlToText("<p>Si a <b and c> d</p>"), "Si a <b and c> d");
});

test("le code entre <pre> garde ses comparaisons et ses retours à la ligne", () => {
  const html = "<pre><code>while (lo<hi) {\n  if (a[m] < x) lo = m+1;\n}</code></pre>";
  assert.equal(htmlToText(html), "while (lo<hi) {\n  if (a[m] < x) lo = m+1;\n}");
});

test("les vraies balises partent, attributs compris", () => {
  assert.equal(htmlToText('<p class="x">Le <strong>coût</strong> est <em>linéaire</em>.</p>'), "Le coût est linéaire.");
  assert.equal(htmlToText('<td colspan="2">a</td>'), "a");
  assert.equal(htmlToText("<p>a<!-- note -->b</p>"), "ab");
});

test("entités nommées et numériques décodées (flèches, inégalités, accents)", () => {
  assert.equal(htmlToText("<p>s &rarr; a &rArr; t, x &le; y &ge; z &ne; 0, 3 &times; 4</p>"), "s → a ⇒ t, x ≤ y ≥ z ≠ 0, 3 × 4");
  assert.equal(htmlToText("<p>&#8594; &#x2264; &eacute;t&eacute; &hellip; &mdash; &alpha;&beta;</p>"), "→ ≤ été … — αβ");
  // Une entité échappée une fois de trop reste lisible telle quelle, sans double décodage.
  assert.equal(htmlToText("<p>&amp;lt;p&amp;gt; et &lt;b&gt;</p>"), "&lt;p&gt; et <b>");
  // Entité inconnue ou point de code invalide : laissés tels quels.
  assert.equal(htmlToText("<p>&foo; &#1114112;</p>"), "&foo; &#1114112;");
});

test("un tableau de trace garde ses colonnes et ses lignes, même sans balises fermantes", () => {
  const html = "<p><strong>Trace :</strong></p><table><tr><th>pt</th><th>s</th></tr><tr><td>1</td><td>s=2</td></tr></table>";
  assert.equal(htmlToText(html), "Trace :\npt | s\n1 | s=2");
  const loose = "<strong>solution:</strong><table><tr><td>pt<td>s=3<tr><td>2<td>s=5</table>";
  assert.equal(htmlToText(loose), "solution:\npt | s=3\n2 | s=5");
  // Cellules écrites sur plusieurs lignes dans la source : une ligne par rangée quand même.
  assert.equal(htmlToText("<table>\n<tr>\n<td>\na\n</td>\n<td>b</td>\n</tr>\n</table>"), "a | b");
});

test("une liste numérotée garde ses numéros (étapes du corrigé)", () => {
  const html = "<p>Corrigé</p><ol><li>Initialiser.</li><li>Relâcher.</li></ol><ul><li>Note</li></ul>";
  assert.equal(htmlToText(html), "Corrigé\n1. Initialiser.\n2. Relâcher.\n- Note");
});

test("un bloc qui s'ouvre après du texte en ligne passe à la ligne", () => {
  assert.equal(htmlToText("<strong>Résultat :</strong><p>3</p><div>fin</div>"), "Résultat :\n3\nfin");
});

test("exposants et indices restent lisibles", () => {
  assert.equal(htmlToText("<p>O(n<sup>2</sup>), 2<sup>n+1</sup>, x<sub>i</sub>, a<sub>i,j</sub></p>"), "O(n^2), 2^(n+1), x_i, a_(i,j)");
});

test("texte brut (indice sans HTML) : retours à la ligne gardés", () => {
  assert.equal(htmlToText("Pense au cas n=0.\nPuis n<3."), "Pense au cas n=0.\nPuis n<3.");
});

test("clip ne coupe ni un mot ni une paire de substitution", () => {
  const t = "Le flot maximal vaut trois unités ici";
  const c = clip(t, 20);
  assert.ok(c.length <= 20, c);
  assert.equal(c, "Le flot maximal…");
  // Un caractère hors BMP (𝔼) à la frontière n'est pas coupé en deux.
  const math = `${"a".repeat(8)}𝔼[X]`;
  const m = clip(math, 10);
  assert.ok(!/[\uD800-\uDBFF]…$/.test(m), JSON.stringify(m));
  // Un mot unique très long est coupé quand même (pas de résultat vide).
  assert.equal(clip("x".repeat(50), 10), `${"x".repeat(9)}…`);
  assert.equal(clip("court", 10), "court");
});

test("LaTeX brut d'un examen écrit (colonne statement_html) : comparaisons et indentation intactes", () => {
  const tex = "Soit $a<b$ et $c>d$.\n\\begin{lstlisting}\ndef f(n):\n    if n<2:\n        return n\n\\end{lstlisting}";
  assert.equal(htmlToText(tex), tex);
});
