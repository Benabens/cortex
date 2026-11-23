"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, UploadCloud, X } from "lucide-react";
import { useLocale, useTranslations } from "use-intl/react";

type Limits = { maxFiles: number; maxFileBytes: number; maxMb: number; maxPages: number };

/**
 * Dépôt de 1 à N annales PDF. Les contrôles d'ici (nombre, taille, type) évitent un aller-retour ;
 * le serveur refait tout (et compte les pages) avant d'admettre l'analyse.
 */
export function UploadForm({ limits }: { limits: Limits }) {
  const t = useTranslations("examTopics");
  const locale = useLocale();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);

  function add(list: FileList | null) {
    if (!list) return;
    setError(null);
    const next = [...files];
    for (const f of Array.from(list)) {
      const isPdf = f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
      if (!isPdf) { setError(t("clientNotPdf", { name: f.name })); continue; }
      if (f.size > limits.maxFileBytes) { setError(t("clientTooBig", { name: f.name, maxMb: limits.maxMb })); continue; }
      if (next.some((g) => g.name === f.name && g.size === f.size)) continue;
      if (next.length >= limits.maxFiles) { setError(t("clientTooMany", { max: limits.maxFiles })); break; }
      next.push(f);
    }
    setFiles(next);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!files.length || busy) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("lang", locale);
    form.set("website", String(new FormData(e.currentTarget).get("website") ?? ""));
    for (const f of files) form.append("files", f, f.name);
    const res = await fetch("/api/exam-topics", { method: "POST", body: form }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { id?: string; error?: string } | null;
    if (res?.status === 202 && body?.id) {
      router.push(`/whats-on-my-exam/r/${body.id}`);
      return;
    }
    setError(body?.error ?? t("network"));
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="d2-card p-4 sm:p-6">
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
        className="relative flex flex-col items-center rounded-[0.9rem] border border-dashed px-4 py-9 text-center transition-colors duration-150"
        style={{ borderColor: over ? "var(--color-accent-hi)" : "var(--bare-field-line)", background: over ? "var(--color-wash-hi)" : "transparent" }}
      >
        <UploadCloud aria-hidden className="size-7 text-accent-hi" strokeWidth={1.75} />
        <p className="mt-3 text-[0.98rem] font-semibold">{t("dropTitle")}</p>
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="mt-1 text-[0.9rem] font-medium text-accent-hi underline decoration-[var(--color-underline-hi)] underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-hi"
        >
          {t("dropBrowse")}
        </button>
        <p className="mt-3 text-[0.78rem]" style={{ color: "var(--bare-faint)" }}>
          {t("dropHint", { maxFiles: limits.maxFiles, maxMb: limits.maxMb, maxPages: limits.maxPages })}
        </p>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => { add(e.target.files); e.target.value = ""; }}
        />
      </div>

      {files.length > 0 && (
        <ul aria-label={t("filesLabel")} className="mt-4 flex flex-col gap-2">
          {files.map((f) => (
            <li key={`${f.name}-${f.size}`} className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-[0.86rem]" style={{ background: "var(--bare-surface-hover)" }}>
              <FileText aria-hidden className="size-4 shrink-0" style={{ color: "var(--bare-faint)" }} strokeWidth={1.75} />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="shrink-0 tabular-nums text-[0.78rem]" style={{ color: "var(--bare-faint)" }}>
                {t("fileSize", { mb: (f.size / 1024 / 1024).toFixed(1) })}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => setFiles(files.filter((g) => g !== f))}
                aria-label={t("fileRemove", { name: f.name })}
                className="rounded-md p-1 hover:bg-[var(--bare-surface)] focus-visible:outline-2 focus-visible:outline-accent-hi"
              >
                <X aria-hidden className="size-4" strokeWidth={2} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Champ piège : hors écran pour un humain, rempli par un robot qui complète tout. */}
      <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor="exam-topics-website">{t("honeypot")}</label>
        <input id="exam-topics-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-lg px-3.5 py-2.5 text-[0.84rem] leading-relaxed" style={{ background: "var(--bare-error-bg)", border: "1px solid var(--bare-error-line)", color: "var(--error-ink)" }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!files.length || busy}
        className="mt-5 inline-flex h-12 w-full items-center justify-center rounded-full bg-accent px-6 text-[0.95rem] font-semibold text-white transition-[background-color,opacity,transform] duration-150 enabled:hover:bg-accent-deep enabled:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55"
      >
        {busy ? t("submitting") : t("submit")}
      </button>
      <p className="mt-2.5 text-center text-[0.78rem]" style={{ color: "var(--bare-faint)" }}>{t("free")}</p>
    </form>
  );
}
