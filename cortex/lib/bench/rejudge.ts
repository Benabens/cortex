import fs from "node:fs";
import path from "node:path";

/** Prépare une sortie indépendante sans recopier les bandes ni les résultats de génération. */
export function prepareRejudgeOutput(sourceDir: string, outputDir: string, db: string): string {
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  if (fs.existsSync(output)) throw new Error(`Le dossier de rejugement existe déjà : ${output}`);
  const runFile = path.join(source, "run.json");
  const run = JSON.parse(fs.readFileSync(runFile, "utf8")) as Record<string, unknown>;
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "run.json"), JSON.stringify({ ...run, db }, null, 1));
  return output;
}
