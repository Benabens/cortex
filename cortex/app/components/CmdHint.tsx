"use client";

import { useState } from "react";

/** Commande copiable affichée sous un message d'erreur (ex. « brew install tectonic »). */
export default function CmdHint({ cmd }: { cmd: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!cmd) return null;
  return (
    <span className="inline-flex items-center gap-1.5 ml-1.5">
      <code
        className="px-1.5 py-0.5 rounded"
        style={{ background: "var(--surface-2)", border: "1px solid var(--line)", fontSize: 12, color: "var(--ink)" }}
      >
        {cmd}
      </code>
      <button
        type="button"
        className="btn btn-quiet"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(cmd);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {}
        }}
      >
        {copied ? "copié ✓" : "copier"}
      </button>
    </span>
  );
}
