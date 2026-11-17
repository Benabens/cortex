#!/usr/bin/env bash
# Paquet de soumission ChatGPT (platform.openai.com/plugins) : construit
# cortex-chatgpt-plugin.zip depuis docs/annuaires/chatgpt-plugin/ (plugin.json,
# mcp.json) et le logo public/mcp-icon-512.png, copié en assets/logo.png.
#
#   cd cortex && bash scripts/build-chatgpt-plugin.sh [chemin/du/paquet.zip]
#
# Par défaut l'archive est écrite à la racine de cortex/ (ignorée par git : elle
# se reconstruit, elle ne se versionne pas). Reproductible : mêmes sources →
# même archive à l'octet près (dates, droits et ordre des fichiers fixés), donc
# l'empreinte affichée à la fin permet de vérifier ce qui a été téléversé.
#
# Refuse de construire si un manifeste est illisible, si une limite du
# formulaire est dépassée, si la version diffère de MCP_SERVER_VERSION ou si un
# TODO reste ailleurs que dans demo_recording_url (seul champ qu'on peut laisser
# pour la fin : la vidéo de démo s'enregistre contre la prod).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# CHATGPT_PLUGIN_SRC : autre dossier de manifestes (tests).
SRC="${CHATGPT_PLUGIN_SRC:-$ROOT/docs/annuaires/chatgpt-plugin}"
LOGO="$ROOT/public/mcp-icon-512.png"
OUT="${1:-$ROOT/cortex-chatgpt-plugin.zip}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac

command -v zip >/dev/null || { echo "build-chatgpt-plugin : la commande zip est introuvable" >&2; exit 1; }

# Contrôles (node est toujours là dans ce dépôt) : JSON, limites, logo, version, TODO.
node - "$SRC/plugin.json" "$SRC/mcp.json" "$LOGO" "$ROOT/lib/mcp/identity.ts" <<'NODE'
const fs = require("node:fs");
const [pluginPath, mcpPath, logoPath, identityPath] = process.argv.slice(2);
const fail = (m) => { console.error(`build-chatgpt-plugin : ${m}`); process.exit(1); };
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { fail(`${p} illisible (${e.message})`); } };
const plugin = read(pluginPath);
read(mcpPath);
const ui = plugin.extensions?.["com.openai"]?.interface ?? fail("plugin.json : extensions.com.openai.interface manquant");
const max = (v, n, what) => { if (typeof v !== "string" || !v.trim() || v.length > n) fail(`${what} : ${v === undefined ? "absent" : `${v.length} caractères`} (1 à ${n})`); };
max(ui.displayName, 30, "displayName");
max(ui.shortDescription, 30, "shortDescription");
max(ui.longDescription, 4000, "longDescription");
max(ui.developerName, 80, "developerName");
(ui.defaultPrompt ?? []).forEach((p, i) => max(p, 128, `defaultPrompt[${i}]`));
if (ui.logo !== "./assets/logo.png") fail(`logo attendu en ./assets/logo.png, trouvé ${ui.logo}`);
const png = fs.readFileSync(logoPath);
if (png.toString("latin1", 1, 4) !== "PNG") fail(`${logoPath} n'est pas un PNG`);
const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
if (w !== h || w < 48) fail(`logo ${w}x${h} : carré d'au moins 48 px attendu`);
const version = /MCP_SERVER_VERSION = "([^"]+)"/.exec(fs.readFileSync(identityPath, "utf8"))?.[1];
if (plugin.version !== version) fail(`version ${plugin.version} ≠ MCP_SERVER_VERSION ${version}`);
const todos = [];
const walk = (v, at) => {
  if (typeof v === "string") { if (/\bTODO\b/.test(v)) todos.push(at); }
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
};
walk(plugin, "plugin");
const blocking = todos.filter((t) => !t.endsWith(".demo_recording_url"));
if (blocking.length) fail(`TODO à remplir : ${blocking.join(", ")}`);
if (todos.length) console.error("build-chatgpt-plugin : ⚠ demo_recording_url est encore un TODO (à remplir avant de soumettre)");
console.error(`build-chatgpt-plugin : ${ui.displayName} ${plugin.version}, logo ${w}x${h}`);
NODE

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/assets"
cp "$SRC/plugin.json" "$SRC/mcp.json" "$STAGE/"
cp "$LOGO" "$STAGE/assets/logo.png"
chmod 644 "$STAGE/plugin.json" "$STAGE/mcp.json" "$STAGE/assets/logo.png"
# Date fixe (la plus ancienne que le format ZIP sache écrire) : l'archive ne dépend pas du moment.
TZ=UTC touch -t 198001010000 "$STAGE/plugin.json" "$STAGE/mcp.json" "$STAGE/assets/logo.png"

rm -f "$OUT"
mkdir -p "$(dirname "$OUT")"
# -X : sans attributs étendus ni uid/gid ; -D : sans entrée de dossier ; ordre des fichiers fixé.
(cd "$STAGE" && TZ=UTC zip -q -X -D "$OUT" plugin.json mcp.json assets/logo.png)

echo "$OUT"
if command -v sha256sum >/dev/null; then SUM="$(sha256sum "$OUT")"; else SUM="$(shasum -a 256 "$OUT")"; fi
echo "sha256 ${SUM%% *}" >&2
