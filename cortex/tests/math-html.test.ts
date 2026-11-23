/**
 * FORMULES DANS LA VUE WEB (demandé le 23/11/2026). Depuis les #203 et #205 le PDF compose les
 * formules que le modèle écrit entre $…$, mais l'écran les montrait brutes : « Soit $x_{t+1} = 2x_t$,
 * que vaut $\frac{x_3}{x_1}$ ? ». `mathHtml` rend le texte du modèle en HTML : formules sûres (même
 * règle que lib/tex-rich) par KaTeX, avec leur MathML, et tout le reste échappé. Textes fictifs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mathHtml, mathHtmlBatch, mathInHtml } from "../lib/math-html";
import { sanitizeHtml } from "../lib/sanitize-html";

/** Le texte visible d'un HTML (MathML et balises retirés), pour vérifier qu'aucune source brute ne reste. */
function visibleHtml(html: string): string {
  return html.replace(/<span class="katex-mathml">[\s\S]*?<\/math><\/span>/g, "").replace(/<[^>]+>/g, "");
}

test("une formule entre $…$ est composée par KaTeX, avec son MathML pour les lecteurs d'écran", () => {
  const html = mathHtml(String.raw`Soit $x_{t+1} = 2x_t$, que vaut $\frac{x_3}{x_1}$ ?`);
  assert.ok(html, "une formule a été rendue");
  assert.equal((html.match(/class="katex"/g) ?? []).length, 2);
  assert.match(html, /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML">/);
  assert.match(html, /<mfrac>/);
  assert.ok(html.startsWith("Soit "), html.slice(0, 40));
  assert.doesNotMatch(visibleHtml(html), /\$|\\frac/);
});

test("\\(…\\), \\[…\\] et $$…$$ aussi ; une formule détachée a son conteneur qui défile (mobile)", () => {
  const html = mathHtml(String.raw`On pose \(\sum_{i=1}^{n} w_i = 1\) puis \[ \|x\|_2 \le 1 \] et $$\frac{1}{n}$$.`);
  assert.ok(html);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 3);
  assert.equal((html.match(/<span class="math-display"><span class="katex-display">/g) ?? []).length, 2);
  assert.doesNotMatch(visibleHtml(html), /\$|\\\(|\\\[|\\sum|\\frac/);
});

test("une formule sans délimiteurs, reconnue par le PDF (lib/tex-rich), l'est aussi à l'écran", () => {
  const html = mathHtml("On a x_{t+1} = 2x_t pour tout t.");
  assert.ok(html);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
  assert.match(visibleHtml(html), /^On a .* pour tout t\.$/);
});

test("jamais de faux positif : prix, code entre accents graves, snake_case, chemin, e-mail", () => {
  for (const s of [
    "Le livre coûte 5$ et le cahier 3$.",
    "coûte $5 et $10",
    "prix : $ 3 $",
    "Appelle `x_{t+1} = $a$` dans le shell.",
    "la variable max_iter et __init__",
    "ouvre /tmp/a_1/data.csv ou C:\\Users\\pi\\doc",
    "écris à jean_dupont@exemple.ch",
  ]) assert.equal(mathHtml(s), null, s);
});

test("une formule invalide reste son texte d'origine, sans casser le reste", () => {
  // refusée par la règle de lib/tex-rich (argument manquant), puis refusée par KaTeX seul (\limits sans opérateur)
  const html = mathHtml(String.raw`Faux : $\frac{a}$ et $x \limits$, juste : $a^2$.`);
  assert.ok(html);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
  assert.ok(html.startsWith(String.raw`Faux : $\frac{a}$ et $x \limits$, juste : `), html.slice(0, 80));
  assert.equal(mathHtml(String.raw`seulement $\begin{array}x\end{array}$`), null);
});

/** Balises que KaTeX produit (HTML + MathML + SVG des racines et des flèches) : rien d'autre ne doit sortir. */
const KATEX_TAGS = new Set(["span", "math", "semantics", "mrow", "mi", "mo", "mn", "ms", "mtext", "mspace", "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "mover", "munder", "munderover", "mtable", "mtr", "mtd", "mstyle", "mpadded", "mphantom", "menclose", "annotation", "svg", "path", "line"]);

test("aucun HTML du modèle n'est injecté : texte et formules ne produisent que le balisage de KaTeX", () => {
  const evil = String.raw`<img src=x onerror=alert(1)> "q" 'a' & $a<b>c$ et $\text{<script>alert(1)</script>}$ et $\href{javascript:alert(1)}{x}$ et $\htmlClass{x}{y}$ et $x_{"><svg onload=alert(1)>}$ et $\frac{1}{2}$`;
  const html = mathHtml(evil);
  assert.ok(html);
  for (const tag of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    assert.ok(KATEX_TAGS.has(tag[1]), `balise inattendue <${tag[1]}>`);
    // attributs de KaTeX seulement : jamais de gestionnaire ni d'URL
    for (const attr of tag[2].matchAll(/\s([\w:-]+)=/g)) assert.match(attr[1], /^(?:class|style|aria-hidden|xmlns|encoding|mathvariant|stretchy|width|height|viewBox|preserveAspectRatio|d|fence|separator|lspace|rspace|linethickness|accent|accentunder|columnalign|rowspacing|columnspacing|scriptlevel|displaystyle|minsize|maxsize|symmetric|largeop|movablelimits|display)$/, `attribut inattendu ${attr[1]}`);
  }
  assert.doesNotMatch(html, /<(?:script|img|b|svg onload)\b/i);
  assert.ok(html.startsWith("&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &#39;a&#39; &amp; "), html.slice(0, 80));
  assert.match(html, /\\href\{javascript:alert\(1\)\}\{x\}/, "la commande refusée reste du texte échappé");
});

test("l'assainisseur, en mode formules, garde le balisage de KaTeX intact", () => {
  const html = mathHtml(String.raw`Soit $\sqrt[3]{x} + \frac{a}{b}$ et \[ \left( \sum_{i=1}^{n} \vec{v}_i \right) \longrightarrow \infty \]`)!;
  const clean = sanitizeHtml(html, { math: true });
  assert.equal((clean.match(/class="katex"/g) ?? []).length, 2);
  for (const piece of ["<mfrac>", "<mroot>", "<svg", "<path", 'style="height:', "vertical-align:-", 'aria-hidden="true"', '<annotation encoding="application/x-tex">']) assert.ok(clean.includes(piece), piece);
  assert.equal((clean.match(/style="/g) ?? []).length, (html.match(/style="/g) ?? []).length, "aucun style de KaTeX perdu");
});

test("l'assainisseur, en mode formules, retire tout ce que KaTeX ne produit pas : styles libres, URL, gestionnaires", () => {
  const clean = sanitizeHtml(
    `<span style="position:fixed;top:0;left:0;width:100%">faux</span><span style="background:url(https://x.example/a)">b</span>` +
      `<span style="height:1em;color:red">c</span><img src=x onerror=alert(1)><a href="javascript:alert(1)">l</a>` +
      `<svg onload=alert(1)><path d="M0 0"/></svg><math><mi href="javascript:alert(1)">x</mi><annotation-xml><foreignObject><img src=x onerror=alert(2)></foreignObject></annotation-xml></math>`,
    { math: true },
  );
  assert.doesNotMatch(clean, /position:fixed|url\(|color:red|<img|<a\b|href|onload|onerror|annotation-xml|foreignObject/i);
  assert.match(clean, /faux/, "le texte reste");
});

test("hors mode formules, l'assainisseur refuse toujours MathML, SVG et style", () => {
  const html = mathHtml(String.raw`$\sqrt{x}$`)!;
  assert.doesNotMatch(sanitizeHtml(html), /<math|<svg|style=/);
});

test("HTML simple du modèle (drill) : assaini strictement d'abord, puis formules composées hors du code", () => {
  const html = mathInHtml(String.raw`<p>Soit $\frac{a}{b}$ &amp; $a &lt; b$</p><pre>$x_1$</pre><p><code>a_{b}</code></p><img src=x onerror=alert(1)><span style="position:fixed">s</span>`);
  assert.ok(html);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 2);
  assert.match(html, /<pre[^>]*>\$x_1\$<\/pre>/);
  assert.match(html, /<code>a_\{b\}<\/code>/);
  assert.match(html, /&amp; <span class="katex">/);
  assert.doesNotMatch(html, /<img|onerror|position:fixed/);
  assert.equal(mathInHtml("<p>Rien à composer : 5$.</p>"), null);
});

test("questions ouvertes de /mock (texToHtml) : formules composées par KaTeX, le repli <em> pour le reste", async () => {
  const { texToHtml } = await import("../lib/exam-latex");
  const tex = String.raw`Montrer que \[ \sum_{i=1}^{n} i = \frac{n(n+1)}{2} \] pour $n \ge 1$ ; coûte \$5 ; \texttt{a\_b} ; $\begin{pmatrix}1 & 2\end{pmatrix}$`;
  const html = texToHtml(tex, { katex: true });
  assert.equal((html.match(/class="katex"/g) ?? []).length, 2);
  assert.equal((html.match(/class="math-display"/g) ?? []).length, 1);
  assert.match(html, /coûte \$5/);
  assert.match(html, /<code>a_b<\/code>/);
  assert.match(html, /<em>/, "une formule refusée garde l'ancien rendu lisible");
  assert.doesNotMatch(visibleHtml(html), /\\sum|\\frac|\\\[|\$n/);
  assert.doesNotMatch(texToHtml(tex), /katex/, "sans l'option (repli HTML de l'examen écrit), rien ne change");
});

test("un ensemble \\{…\\} dans une formule de /mock est composé, hors formule ses accolades restent", async () => {
  const { texToHtml } = await import("../lib/exam-latex");
  const html = texToHtml(String.raw`$S = \{1, 2\}$ et \{a\}`, { katex: true });
  assert.equal((html.match(/class="katex"/g) ?? []).length, 1);
  assert.match(html, /<\/span> et \{a\}$/);
});

test("un environnement equation ou align de /mock est une formule détachée, qui défile dans son conteneur", async () => {
  const { texToHtml } = await import("../lib/exam-latex");
  const html = texToHtml(String.raw`Soit \begin{align*} f(x) &= x^2 + 2x + 1 \\ &= (x+1)^2 \end{align*} et \begin{equation} \int_0^1 x\,dx = \frac{1}{2} \end{equation}`, { katex: true });
  assert.equal((html.match(/class="math-display"/g) ?? []).length, 3, "une formule détachée par ligne de l'align, une pour l'equation");
  assert.doesNotMatch(visibleHtml(html), /\\begin|\\int|&amp;/);
});

test("un lot a un budget de formules : au-delà, le texte reste tel quel (une requête ne bloque pas le serveur)", () => {
  const html = mathHtmlBatch(["$a$ et $b$", "$c$ puis $d$", "$e$"], 3);
  assert.equal((html[0]!.match(/class="katex"/g) ?? []).length, 2);
  assert.equal((html[1]!.match(/class="katex"/g) ?? []).length, 1);
  assert.match(html[1]!, /puis \$d\$$/);
  assert.equal(html[2], null);
});

test("POST /api/math borne le travail d'une requête : textes trop longs et lot trop gros restent tels quels", async () => {
  const { POST } = await import("../app/api/math/route");
  const post = async (texts: string[]) => {
    const res = await POST(new Request("http://localhost/api/math", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts }) }) as never);
    return ((await res.json()) as { html: (string | null)[] }).html;
  };
  const ok = await post(["Soit $x_1$.", "aucune formule"]);
  assert.match(ok[0]!, /class="katex"/);
  assert.equal(ok[1], null);
  // une formule géante (« x_1 x_1 … » fusionnés) n'est pas composée ; un lot énorme s'arrête à son budget
  const t0 = Date.now();
  const big = await post(Array(60).fill("x_1 ".repeat(1400)));
  assert.ok(Date.now() - t0 < 3000, `requête bornée (${Date.now() - t0} ms)`);
  assert.equal(big.length, 60);
  assert.ok(big.every((h) => h === null));
  assert.equal((await post(["x_1 ".repeat(2000)]))[0], null, "texte au-delà de la borne : renvoyé tel quel");
});
