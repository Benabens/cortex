/**
 * FORMULES ET PUCES DU TEXTE DU MODÈLE DANS LE PDF (signalé le 22/11/2026). Les énoncés, options et
 * corrigés des QCM et des questions composées passaient tout entiers par `esc` : « $\frac{a}{b}$ »,
 * « \(\sum_i w_i\) » ou « x_{t+1} » s'imprimaient tels quels, et les puces « - » d'une liste se
 * suivaient sur une seule ligne. Textes fictifs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { formulasOrText, markdownListsTex, texInline, texText, wrapBareFormulas } from "../lib/tex-rich";

test("une formule entre $…$, \\(…\\), \\[…\\] ou $$…$$ passe en mode mathématique", () => {
  assert.equal(texInline(String.raw`Soit $\frac{a}{b}$ fixé`), String.raw`Soit $\frac{a}{b}$ fixé`);
  assert.equal(texInline(String.raw`et \(\sum_i w_i = 1\).`), String.raw`et $\sum_i w_i = 1$.`);
  assert.equal(texInline(String.raw`où \[ \|x\|_2 \le 1 \] tient`), String.raw`où $\displaystyle \|x\|_2 \le 1$ tient`);
  assert.equal(texInline(String.raw`où $$x^2$$ tient`), String.raw`où $\displaystyle x^2$ tient`);
});

test("un passage douteux entre délimiteurs reste du texte échappé : montants, LaTeX hors maths, formule mal formée", () => {
  assert.equal(texInline("coûte $5 et $10"), String.raw`coûte \$5 et \$10`);
  assert.equal(texInline("prix : $ 3 $"), String.raw`prix : \$ 3 \$`);
  for (const bad of [String.raw`$\begin{x}$`, String.raw`$a % b$`, String.raw`$a & b$`, String.raw`$a \\ b$`, String.raw`$\frac{a}$`, String.raw`$x^^2$`, String.raw`$\input{f}$`, String.raw`$a}$`, String.raw`$\left( x$`]) {
    assert.ok(!/^\$[^\\]/.test(texInline(bad)) && texInline(bad).startsWith(String.raw`\$`), `${bad} → ${texInline(bad)}`);
  }
});

test("un mot en snake_case, un nom de fichier ou un chemin restent du texte", () => {
  for (const s of ["snake_case", "max_iter = 10", "le fichier data_1.csv", "train_test_split", "C:\\temp\\new", "a_b.py", "__init__"]) {
    assert.ok(!texInline(s).includes("$"), `${s} → ${texInline(s)}`);
  }
});

test("une formule sans délimiteurs, reconnue seulement quand elle est sûre, passe en maths", () => {
  assert.equal(texInline("on calcule x_{t+1} ici"), String.raw`on calcule $x_{t+1}$ ici`);
  assert.equal(texInline(String.raw`soit \frac{a}{b} et \sum_i w_i`), String.raw`soit $\frac{a}{b}$ et $\sum_i w_i$`);
  assert.equal(texInline("avec x^2 et a_n."), String.raw`avec $x^2$ et $a_n$.`);
  // atomes voisins reliés par des opérateurs : une seule formule
  assert.equal(texInline(String.raw`x_{t+1} = x_t - \eta \nabla f(x_t)`), String.raw`$x_{t+1} = x_t - \eta \nabla$ f($x_t$)`);
  // une commande inconnue ou une séquence d'échappement de code ne sont pas des maths
  assert.equal(texInline(String.raw`print("a\n") et \foo`), String.raw`print("a\textbackslash{}n") et \textbackslash{}foo`);
});

test("des puces Markdown (« - », « * », « • ») et une liste numérotée deviennent de vraies listes", () => {
  assert.equal(
    texText("Soit :\n- un $x^2$\n* deux\n• trois\nFin."),
    ["Soit :", String.raw`\begin{itemize}[nosep]`, String.raw`\item un $x^2$`, String.raw`\item deux`, String.raw`\item trois`, String.raw`\end{itemize}`, "Fin."].join("\n"),
  );
  assert.equal(texText("1. un\n2) deux"), [String.raw`\begin{enumerate}[nosep]`, String.raw`\item un`, String.raw`\item deux`, String.raw`\end{enumerate}`].join("\n"));
  // une liste qui reprend à 3 garde sa numérotation
  assert.equal(texText("3. trois\n4. quatre").split("\n")[0], String.raw`\begin{enumerate}[nosep,start=3]`);
  // un tiret sans espace, un nombre en début de ligne ou une année ne sont pas des puces
  for (const s of ["-5 est négatif", "2026. Une année", "x\n-1"]) assert.ok(!texText(s).includes(String.raw`\item`), s);
});

test("les sauts de ligne hors listes suivent la consigne de l'appelant, une ligne vide coupe le paragraphe", () => {
  assert.equal(texText("a\nb"), "a\nb");
  assert.equal(texText("a\nb", String.raw`\newline `), String.raw`a\newline b`);
  assert.equal(texText("a\n\nb"), String.raw`a\par b`);
  assert.equal(texText("a\n- b", String.raw`\newline `), ["a", String.raw`\begin{itemize}[nosep]`, String.raw`\item b`, String.raw`\end{itemize}`].join("\n"));
});

test("LaTeX libre : une formule sans délimiteurs est mise entre $…$, jamais dans les maths, le code ou un mot", () => {
  assert.equal(wrapBareFormulas(String.raw`Montrez que x_{t+1} converge, avec $\frac{a}{b}$ et \frac{c}{d}.`), String.raw`Montrez que $x_{t+1}$ converge, avec $\frac{a}{b}$ et $\frac{c}{d}$.`);
  assert.equal(wrapBareFormulas(String.raw`deja $x_{t+1}$ et \(y_t\) et \texttt{x_t}`), null);
  assert.equal(wrapBareFormulas(String.raw`le fichier snake\_case.py`), null);
});

test("LaTeX libre : les puces Markdown deviennent une liste, hors code, figures, tableaux et maths", () => {
  assert.equal(markdownListsTex("Soit :\n- a\n- b\nFin"), ["Soit :", String.raw`\begin{itemize}[nosep]`, String.raw`\item a`, String.raw`\item b`, String.raw`\end{itemize}`, "Fin"].join("\n"));
  assert.equal(markdownListsTex("1. a\n2. $x$"), [String.raw`\begin{enumerate}[nosep]`, String.raw`\item a`, String.raw`\item $x$`, String.raw`\end{enumerate}`].join("\n"));
  for (const keep of [
    String.raw`\begin{lstlisting}` + "\n- yaml: 1\n" + String.raw`\end{lstlisting}`,
    String.raw`\begin{verbatim}` + "\n* x\n" + String.raw`\end{verbatim}`,
    String.raw`\[` + "\n  a\n  - b\n" + String.raw`\]`,
    String.raw`\begin{align*}` + "\nx &= 1\n- 2\n" + String.raw`\end{align*}`,
    String.raw`\begin{tikzpicture}` + "\n- \\draw (0,0);\n" + String.raw`\end{tikzpicture}`,
  ]) assert.equal(markdownListsTex(keep), keep);
});

test("une compilation qui échoue avec des formules est retentée avec les formules en texte, une seule fois", async () => {
  const tries: string[] = [];
  const build = async () => {
    const tex = texInline("soit $x^2$");
    tries.push(tex);
    if (!tex.includes("\\$")) throw new Error("compilation"); // formule composée : le moteur échoue
    return tex;
  };
  assert.deepEqual(await formulasOrText(build), { value: String.raw`soit \$x\textasciicircum{}2\$`, asText: true });
  assert.equal(tries.length, 2);
  // sans formule composée, rien à retenter : l'erreur remonte telle quelle
  await assert.rejects(formulasOrText(async () => { texInline("sans formule"); throw new Error("autre"); }), /autre/);
});

test("un chemin, une URL, une adresse ou du code entre accents graves ne deviennent jamais des maths (revue du 22/11)", () => {
  for (const s of ["github.com/u/x_y", "/tmp/a_1/log", "a_b@epfl.ch", String.raw`C:\Users\pi\doc`, "`$x$` et `x_t`", "voir `\\frac{a}{b}`"]) {
    assert.ok(!/(?<!\\)\$/.test(texInline(s)), `${s} → ${texInline(s)}`);
  }
  // deux commandes collées restent une formule
  assert.equal(texInline(String.raw`soit \eta\nabla f`), String.raw`soit $\eta\nabla$ f`);
});
