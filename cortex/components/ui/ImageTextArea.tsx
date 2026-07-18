"use client";

import { useEffect, useId, useState } from "react";
import { X, ImagePlus } from "lucide-react";
import { cn } from "@/lib/ux/cn";

/**
 * P-B — Saisie texte AVEC image INLINE. On colle (⌘V) ou on glisse-dépose une image DANS la zone
 * de texte, tout en continuant à écrire : vignette inline retirable, PAS de bouton « Image
 * (optionnelle) » / « Screenshot » séparé. Contrôlé par le parent (texte + File). Réutilisé par
 * Faiblesses et Entraînement.
 */
export function ImageTextArea({
  value,
  onChange,
  image,
  onImageChange,
  placeholder,
  ariaLabel,
  rows = 3,
  disabled = false,
  autoFocus = false,
  onEnter,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  image: File | null;
  onImageChange: (f: File | null) => void;
  placeholder?: string;
  ariaLabel: string;
  rows?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** ⌘/Ctrl+Enter → soumettre (optionnel). */
  onEnter?: () => void;
  className?: string;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const hintId = useId();

  // Aperçu : object URL révoqué à chaque changement d'image (pas de fuite mémoire).
  useEffect(() => {
    if (!image) { setUrl(null); return; }
    const u = URL.createObjectURL(image);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [image]);

  const firstImage = (files: FileList | null | undefined): File | null => {
    if (!files) return null;
    for (const f of Array.from(files)) if (f.type.startsWith("image/")) return f;
    return null;
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of Array.from(items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) { onImageChange(f); e.preventDefault(); return; } // image → on ne colle pas de texte parasite
      }
    }
  };

  return (
    <div
      onDragOver={(e) => {
        if (disabled) return;
        if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setDragOver(true); }
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={(e) => {
        if (disabled) return;
        const f = firstImage(e.dataTransfer.files);
        if (f) { e.preventDefault(); onImageChange(f); }
        setDragOver(false);
      }}
      className={cn(
        "rounded-xl border bg-surface-2/40 transition-colors focus-within:border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] focus-within:ring-2 focus-within:ring-[color-mix(in_oklch,var(--color-violet)_22%,transparent)]",
        dragOver ? "border-[color-mix(in_oklch,var(--color-violet)_60%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_7%,transparent)]" : "border-line-strong",
        disabled && "opacity-60",
        className
      )}
    >
      {image && url && (
        <div className="flex flex-wrap items-center gap-2 px-3 pt-3">
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="Aperçu de l’image jointe" className="h-16 w-16 rounded-lg border border-line object-cover" />
            <button
              type="button"
              onClick={() => onImageChange(null)}
              aria-label="Retirer l’image"
              className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-line-strong bg-surface-3 text-ink-2 shadow-[var(--shadow-pop)] transition-colors hover:text-ink-1 focus-visible:outline-2 focus-visible:outline-violet focus-visible:outline-offset-2"
            >
              <X className="size-3" strokeWidth={2.5} />
            </button>
          </div>
          <span className="truncate text-[0.74rem] text-ink-4">{image.name}</span>
        </div>
      )}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPaste={onPaste}
        onKeyDown={(e) => { if (onEnter && (e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); onEnter(); } }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-describedby={hintId}
        rows={rows}
        disabled={disabled}
        data-focus-parent
        className="w-full resize-none bg-transparent px-3.5 py-3 text-[0.9rem] leading-relaxed text-ink-1 placeholder:text-ink-4 focus:outline-none"
      />
      {/* Toujours présent (visuellement masqué quand une image est jointe) → l'aide « coller une
          image » est annoncée aux lecteurs d'écran via aria-describedby, pas seulement visible. */}
      <div id={hintId} className={cn("pointer-events-none flex items-center gap-1.5 px-3.5 pb-2.5 text-[0.72rem] text-ink-4", image && "sr-only")}>
        <ImagePlus className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
        Colle (⌘V) ou glisse une image dans la zone pour la joindre.
      </div>
    </div>
  );
}
