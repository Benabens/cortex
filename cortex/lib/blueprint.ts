import { sqlite } from "@/db/client";
import { ARCHETYPES, type Archetype } from "@/lib/archetypes";

export type Slot = { category: string; points: number; brief: string; archetypeId: string };

/** Pondération d'un archétype par les faiblesses de Ben (matching mots-clés). */
function weaknessBoost(a: Archetype, weaknesses: string[]): number {
  const hay = weaknesses.join(" ").toLowerCase();
  return a.topics.some((t) => hay.includes(t)) ? 1.5 : 1;
}

/**
 * Blueprint de couverture : fixe les 6 slots {catégorie, points, archétype} de la
 * structure Final 2025 (Networking×2 / OS×2 / C / Labs ≈ 180 pts), en choisissant
 * l'archétype selon poids study guide × faiblesses. Les archétypes Networking/OS
 * étant 2 par catégorie, le boost de faiblesse détermine l'ORDRE/le focus des briefs.
 */
export function buildBlueprint(): Slot[] {
  const weaknesses = (
    sqlite.prepare(`SELECT topic, description FROM weaknesses ORDER BY severity DESC LIMIT 10`).all() as {
      topic: string;
      description: string | null;
    }[]
  ).map((w) => `${w.topic} ${w.description ?? ""}`);

  const pick = (category: Archetype["category"]) =>
    ARCHETYPES.filter((a) => a.category === category).sort(
      (x, y) => y.weight * weaknessBoost(y, weaknesses) - x.weight * weaknessBoost(x, weaknesses)
    );

  const net = pick("Networking");
  const os = pick("OS");
  const c = pick("C")[0];
  const labs = pick("Labs")[0];

  const mk = (a: Archetype, points: number): Slot => ({
    category: a.category,
    points,
    archetypeId: a.id,
    brief: [
      `ARCHÉTYPE « ${a.id} » — ${a.concept}.`,
      `Construction : ${a.structure}`,
      `Grilles de réponse : ${a.grid}.`,
      `Figure : ${a.figure}.`,
      `PIÈGE à inclure (ré-instancié sur TON setup, pas recopié) : ${a.trap}.`,
    ].join(" "),
  });

  return [mk(net[0], 50), mk(net[1] ?? net[0], 50), mk(os[0], 25), mk(os[1] ?? os[0], 30), mk(c, 10), mk(labs, 15)];
}
