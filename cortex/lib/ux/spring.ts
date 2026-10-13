/**
 * Ressort amorti → courbe CSS `linear()`.
 *
 * L'app n'embarque aucune bibliothèque d'animation : plutôt qu'en ajouter une pour deux
 * interrupteurs, on résout l'équation du ressort ici et on la donne au navigateur sous forme
 * d'une courbe échantillonnée. Les paramètres sont ceux de Motion / SwiftUI, pour qu'on puisse
 * les régler à l'oreille :
 *   - `response` : durée perçue du mouvement, en secondes ;
 *   - `bounce`   : 0 = amortissement critique (aucun dépassement), 0,3 = un rebond net, sans
 *                  seconde oscillation visible.
 *
 * Les jetons `--spring-*` de `app/globals.css` sont la sortie de cette fonction : le test
 * `tests/spring.test.ts` échoue si quelqu'un modifie l'un sans l'autre.
 */

export type Spring = { response: number; bounce: number };

/** Le bord qui part en tête : rapide, sans dépassement (il ne sort jamais du rail). */
export const SPRING_LEAD: Spring = { response: 0.16, bounce: 0 };
/** Le bord qui suit : plus lent (d'où l'étirement), puis un rebond court à l'arrivée. */
export const SPRING_TRAIL: Spring = { response: 0.24, bounce: 0.28 };

/** En dessous de cet écart à la cible, le ressort est considéré comme arrivé. */
const REST = 0.005;
const SAMPLES = 28;

/** Position du ressort à l'instant `t` (s), de 0 vers 1, vitesse initiale nulle. */
export function springValue({ response, bounce }: Spring, t: number): number {
  const w0 = (2 * Math.PI) / response;
  const zeta = Math.min(1, Math.max(0.05, 1 - bounce));
  if (zeta >= 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
}

/** Temps (ms) au bout duquel le ressort ne s'écarte plus de la cible de plus de `REST`. */
export function springDurationMs({ response, bounce }: Spring): number {
  const w0 = (2 * Math.PI) / response;
  const zeta = Math.min(1, Math.max(0.05, 1 - bounce));
  if (zeta < 1) return Math.round((-Math.log(REST) / (zeta * w0)) * 1000);
  // Critique : e^{-x}(1 + x) = REST n'a pas de solution fermée, on la cherche par dichotomie.
  let lo = 0;
  let hi = 20;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (Math.exp(-mid) * (1 + mid) > REST) lo = mid;
    else hi = mid;
  }
  return Math.round((hi / w0) * 1000);
}

/** `linear(0, …, 1)` : la courbe du ressort, à poser sur une transition de `springDurationMs`. */
export function springEasing(spring: Spring): string {
  const total = springDurationMs(spring) / 1000;
  const points: string[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const v = i === SAMPLES ? 1 : springValue(spring, (total * i) / SAMPLES);
    points.push(String(Math.round(v * 1000) / 1000));
  }
  return `linear(${points.join(", ")})`;
}

/** `<durée> <courbe>`, prêt pour une déclaration `transition`. */
export function springTransition(spring: Spring): string {
  return `${springDurationMs(spring)}ms ${springEasing(spring)}`;
}
