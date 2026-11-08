import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd(), "e2e/.runtime");
if (path.basename(root) !== ".runtime" || path.basename(path.dirname(root)) !== "e2e") throw new Error(`Chemin runtime E2E inattendu: ${root}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, "pglite"), { recursive: true });
fs.mkdirSync(path.join(root, "data"), { recursive: true });
