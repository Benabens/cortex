/**
 * Maths du LaTeX des examens écrits rendues en HTML (texToHtml : question ouverte sur /mock, repli
 * quand le PDF ne compile pas). Une macro inconnue était effacée : « $O(n \log n)$ » s'affichait
 * « O(n  n) », « $a \leq b$ » « a  b », « $\alpha$ » rien du tout.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { texToHtml } from "../lib/exam-latex";

/** Texte visible (balises retirées, entités de base décodées, espaces resserrés). */
const shown = (tex: string) =>
  texToHtml(tex).replace(/<br>/g, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").trim();

test("relations, flèches et opérateurs gardés", () => {
  assert.equal(shown(String.raw`$a \leq b$, $x \geq y$, $x \neq y$, $x \in S$, $a \cdot b$, $A \subseteq B$`), "a ≤ b, x ≥ y, x ≠ y, x ∈ S, a · b, A ⊆ B");
  assert.equal(shown(String.raw`$x \gets 0$, $A \Rightarrow B$, $p \iff q$, $f \colon A \to B$`), "x ← 0, A ⇒ B, p ⇔ q, f : A → B");
  assert.equal(shown(String.raw`$a \lt b \gt c$, $a \le b \ge c$`), "a < b > c, a ≤ b ≥ c");
});

test("noms de fonctions gardés et séparés", () => {
  assert.equal(shown(String.raw`$O(n \log n)$, $O(n\log n)$, $\max(a,b)$, $n \bmod 2$, $a \equiv b \pmod{m}$`), "O(n log n), O(n log n), max(a,b), n mod 2, a ≡ b (mod m)");
});

test("lettres grecques, fractions, racines, ensembles, partie entière", () => {
  assert.equal(shown(String.raw`$\alpha + \beta$, $\Theta(n)$, $\varepsilon$`), "α + β, Θ(n), ε");
  assert.equal(shown(String.raw`$\frac{n}{2}$, $\frac{n+1}{2}$, $\sqrt{n}$, $\sqrt{n+1}$, $\frac12$`), "n/2, (n+1)/2, √n, √(n+1), 1/2");
  assert.equal(shown(String.raw`$\{1, 2\}$, $\lfloor n/2 \rfloor$, $\lceil x \rceil$, $\left( x \right)$, $\mathbb{R}$, $\emptyset$`), "{1, 2}, ⌊ n/2 ⌋, ⌈ x ⌉, ( x ), ℝ, ∅");
  assert.equal(shown(String.raw`$\binom{n}{k}$, $90^\circ$, $|x|$, $\lvert x \rvert$`), "C(n, k), 90°, |x|, | x |");
});

test("exposants d'une lettre grecque ou d'une commande", () => {
  assert.equal(texToHtml(String.raw`$e^{\alpha t}$ et $x^\alpha$`), "<em>e<sup>α t</sup></em> et <em>x<sup>α</sup></em>");
});

test("maths en display : $$…$$, \\[…\\], \\(…\\) et equation/align, sans délimiteur à l'écran", () => {
  assert.equal(shown(String.raw`$$\sum_{i=1}^{n} i$$`), "∑i=1n i");
  assert.equal(shown(String.raw`avant \[ x^2 \leq 1 \] après \( y \)`), "avant x2 ≤ 1 après y");
  const eq = shown(String.raw`\begin{equation} E = mc^2 \end{equation} puis \begin{align*} a &= b \\ c &= d \end{align*}`);
  assert.doesNotMatch(eq, /equation|align|\$|&/);
  assert.match(eq, /E = mc2/);
  assert.match(eq, /a = b/);
  // Un saut de ligne \\[2pt] n'est pas un début de maths.
  assert.equal(shown(String.raw`ligne\\[2pt]suite`), "ligne\nsuite");
});

test("texte : accents LaTeX, guillemets et environnements inconnus sans nom qui fuit", () => {
  assert.equal(shown("Le caf\\'e co\\^ute ``cher'' et \\og bien \\fg{}, \\c{c}a et na\\\"ive"),"Le café coûte “cher” et « bien », ça et naïve");
  assert.equal(shown(String.raw`\begin{quote}Cité\end{quote} \begin{minipage}{0.5\textwidth}Bloc\end{minipage}`), "Cité Bloc");
  assert.equal(shown(String.raw`Flèche \to dans le texte, et \ldots`), "Flèche → dans le texte, et …");
});

test("le code reste du code (pas de symboles injectés)", () => {
  assert.equal(shown(String.raw`\texttt{a\_b} et \begin{lstlisting}
if a <= b: x = "\alpha"
\end{lstlisting}`), "a_b et if a <= b: x = \"\\alpha\"");
});

test("formule hors maths et puces Markdown : composées comme dans le PDF (signalé le 22/11/2026)", () => {
  const html = texToHtml(String.raw`Montrez que x_{t+1} converge vers \frac{a}{b} :` + "\n- premier point\n- second point\n1. étape");
  assert.match(html, /<em>x<sub>t\+1<\/sub><\/em>/);
  assert.match(html, /<em>a\/b<\/em>/);
  assert.match(html, /<ul>\s*<li>premier point\s*<li>second point\s*<\/ul>/);
  assert.match(html, /<ol>\s*<li>étape\s*<\/ol>/);
  // un mot en snake_case reste un mot
  assert.equal(shown("le fichier snake_case.py"), "le fichier snake_case.py");
});
