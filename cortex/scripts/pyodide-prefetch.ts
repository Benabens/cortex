/**
 * PRÉCHARGEMENT des paquets Python de la vérification WebAssembly (pandas et ses dépendances).
 *
 * Le paquet npm pyodide n'embarque que le runtime : sans ce script, le premier loadPackage("pandas")
 * de chaque conteneur télécharge ~20 Mo depuis le CDN jsDelivr, dans le délai d'une vérification,
 * et échoue si le CDN ne répond pas. Lancé au build de l'image (Dockerfile), il dépose les wheels
 * dans node_modules/pyodide, là où loadPackage les cherche avant tout téléchargement.
 *
 *   tsx scripts/pyodide-prefetch.ts           télécharge ce qui manque, sort en 1 s'il manque encore un fichier
 *   tsx scripts/pyodide-prefetch.ts --check   ne télécharge rien : exécute un programme pandas en WebAssembly
 *                                             (la CI le lance sans réseau sur l'image construite)
 */
import { loadPyodide } from "pyodide";
import { pyodidePackageDir, pyodidePackagesMissing, runPythonWasm } from "../lib/pyodide-sandbox";

// Les seuls paquets que le worker charge (lib/pyodide-sandbox.ts).
const PACKAGES = ["pandas"];

async function main(): Promise<number> {
  const check = process.argv.includes("--check");
  if (!check && pyodidePackagesMissing(PACKAGES).length) {
    const pyodide = await loadPyodide();
    await pyodide.loadPackage(PACKAGES);
  }
  const missing = pyodidePackagesMissing(PACKAGES);
  if (missing.length) {
    console.error(`✗ paquets Pyodide absents de ${pyodidePackageDir()} : ${missing.join(", ")}`);
    return 1;
  }
  if (check) {
    process.env.CORTEX_PYTHON_WASM = "1";
    const r = await runPythonWasm("import pandas as pd\nprint(pd.Series([20, 22]).sum())", { timeoutMs: 10_000 });
    if (!r.ok || r.stdout.trim() !== "42") {
      console.error(`✗ pandas en WebAssembly : ${r.reason ?? `sortie « ${r.stdout.trim()} »`} ${r.stderr.slice(0, 300)}`);
      return 1;
    }
    console.log(`✓ pandas exécuté en WebAssembly depuis les fichiers locaux (démarrage ${r.startupMs} ms)`);
    return 0;
  }
  console.log(`✓ paquets Pyodide en local (${pyodidePackageDir()}) : ${PACKAGES.join(", ")} et dépendances`);
  return 0;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
