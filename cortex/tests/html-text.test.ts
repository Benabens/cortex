/**
 * Texte utile d'une page HTML enregistrée (lib/html-text) : la structure de la plateforme part,
 * la matière reste — y compris un encadré dans la leçon, plusieurs articles frères et les formules
 * MathJax écrites en <script type="math/tex">. Pages fictives.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlPageText } from "../lib/html-text";

const LESSON = "The Orvelle transform maps every bounded wave to its spectrum. ".repeat(4);
const page = (body: string) => `<html><head><title>Orvelle</title></head><body><nav>My courses</nav>${body}<footer>Get the mobile app</footer></body></html>`;

test("un encadré et un en-tête dans la leçon restent", () => {
  const { text } = htmlPageText(page(`<main><header><h1>Week 3</h1></header><p>${LESSON}</p><aside>Definition: an Orvelle wave is bounded.</aside></main><aside>Upcoming events</aside>`), "p.html");
  assert.match(text, /Week 3/);
  assert.match(text, /Definition: an Orvelle wave is bounded\./);
  assert.ok(!text.includes("Upcoming events") && !text.includes("My courses") && !text.includes("mobile app"), text);
});

test("plusieurs articles frères (fil de discussion) : tous lus", () => {
  const { text } = htmlPageText(page(`<article><p>${LESSON}</p></article><article><p>Second post: the inverse transform exists.</p></article>`), "p.html");
  assert.match(text, /Orvelle transform maps/);
  assert.match(text, /Second post: the inverse transform exists\./);
});

test("formules MathJax en script : gardées en LaTeX à leur place", () => {
  const { text } = htmlPageText(page(`<main><p>${LESSON} Energy is <script type="math/tex">E=mc^2</script> and</p><script type="math/tex; mode=display">\\int_0^1 f</script><script>track()</script></main>`), "p.html");
  assert.match(text, /Energy is \$E=mc\^2\$ and/);
  assert.match(text, /\$\$\\int_0\^1 f\$\$/);
  assert.ok(!text.includes("track()"), text);
});
