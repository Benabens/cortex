"use client";

import { useEffect, useRef, useState } from "react";
import { UploadCloud, Check, Sparkles, FolderInput, AlertTriangle } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { WeightBar } from "@/components/viz/WeightBar";
import { useCourse, useJob, JOB_ACTIVE, asText, type ApiError } from "@/lib/ux/api";
import { cn } from "@/lib/ux/cn";

const ACCEPT = ".pdf,.html,.htm,.txt,.md";

/**
 * Import RÉEL :
 * — dropzone / fichier(s) → POST /api/refs/upload (multipart) → ingestion + job « format » ;
 * — dossier local (chemin) → POST /api/sources/import {path} → job « ingest » (409 sur cs-202) ;
 * — « Préparer le cours » → POST /api/prepare → job complet (ingestion → format → blueprint).
 */
export function ImportPanel({ onChanged }: { onChanged: () => void }) {
  const { courseId } = useCourse();
  const isCs202 = courseId === "cs-202";
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadedMsg, setUploadedMsg] = useState<string | null>(null);
  const [dirPath, setDirPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [jobKind, setJobKind] = useState<"format" | "ingest" | "prepare" | null>(null);
  const job = useJob(jobId);
  const running = jobId != null && (!job || JOB_ACTIVE.includes(job.status));
  const notified = useRef(false);

  useEffect(() => {
    setJobId(null);
    setJobKind(null);
    setError(null);
    setUploadedMsg(null);
    notified.current = false;
  }, [courseId]);

  useEffect(() => {
    if (!job || JOB_ACTIVE.includes(job.status) || notified.current) return;
    notified.current = true;
    setJobId(null);
    if (job.status === "error" || job.status === "failed") {
      setError(asText(job.error) ?? "Le traitement a échoué. Réessaie.");
    } else {
      setUploadedMsg(
        jobKind === "prepare"
          ? "Cours préparé — types d’exos et poids mis à jour."
          : jobKind === "ingest"
            ? "Dossier ingéré — le corpus est à jour."
            : "Format re-détecté sur tes annales."
      );
      onChanged();
    }
    setJobKind(null);
  }, [job, jobKind, onChanged]);

  const startJob = (id: number, kind: "format" | "ingest" | "prepare") => {
    notified.current = false;
    setJobId(id);
    setJobKind(kind);
  };

  const upload = async (files: FileList | File[]) => {
    const list = [...files].filter((f) => /\.(pdf|html?|txt|md)$/i.test(f.name));
    if (!list.length) {
      setError("Formats acceptés : PDF, HTML, TXT, MD.");
      return;
    }
    setError(null);
    setUploadedMsg(null);
    setUploading(true);
    try {
      const fd = new FormData();
      for (const f of list) fd.append("file", f);
      const res = await fetch(`/api/refs/upload?course=${encodeURIComponent(courseId)}`, {
        method: "POST",
        body: fd,
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? `Erreur ${res.status}`);
      setUploadedMsg(`${d.files.length} fichier${d.files.length > 1 ? "s" : ""} ingéré${d.files.length > 1 ? "s" : ""}.`);
      onChanged();
      if (d.formatJobId) startJob(d.formatJobId, "format");
    } catch (e) {
      setError((e as Error).message || "L’upload a échoué.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const importFolder = async () => {
    if (running || !dirPath.trim()) return;
    setError(null);
    setUploadedMsg(null);
    try {
      const res = await fetch(`/api/sources/import?course=${encodeURIComponent(courseId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: dirPath.trim() }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        const err: ApiError = { status: res.status, message: d?.error ?? `Erreur ${res.status}` };
        throw err;
      }
      startJob(d.jobId, "ingest");
    } catch (e) {
      setError((e as ApiError).message || "L’import du dossier a échoué.");
    }
  };

  const prepare = async () => {
    if (running) return;
    setError(null);
    setUploadedMsg(null);
    try {
      const res = await fetch(`/api/prepare?course=${encodeURIComponent(courseId)}`, { method: "POST" });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error ?? `Erreur ${res.status}`);
      startJob(d.jobId, "prepare");
    } catch (e) {
      setError((e as Error).message || "Impossible de lancer la préparation.");
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Dropzone — upload réel d'annales */}
      <Panel className="p-5 rise-in" style={{ animationDelay: "60ms" }}>
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            upload(e.dataTransfer.files);
          }}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-4 py-9 text-center transition-colors",
            dragOver
              ? "border-[color-mix(in_oklch,var(--color-violet)_60%,transparent)] bg-[color-mix(in_oklch,var(--color-violet)_10%,transparent)]"
              : "border-line-strong bg-surface-2/30 hover:border-[color-mix(in_oklch,var(--color-violet)_45%,transparent)]"
          )}
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            onChange={(e) => e.target.files && upload(e.target.files)}
          />
          <span
            className="grid size-12 place-items-center rounded-2xl text-white"
            style={{
              background: "linear-gradient(150deg, var(--color-violet), var(--color-cyan))",
              boxShadow: "var(--shadow-glow-violet), inset 0 1px 0 rgba(255,255,255,0.28)",
            }}
          >
            <UploadCloud className="size-6" strokeWidth={2} />
          </span>
          <div>
            <p className="text-[0.95rem] font-semibold text-ink-1">
              {uploading ? "Ingestion en cours…" : "Glisse un examen ici"}
            </p>
            <p className="mt-0.5 text-[0.8rem] text-ink-3">ou clique pour parcourir — il rejoint tes annales de référence</p>
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {["PDF", "HTML", "TXT", "MD"].map((f) => (
              <span key={f} className="rounded-md border border-line bg-surface-1/60 px-2 py-0.5 font-mono text-[0.68rem] text-ink-3">
                {f}
              </span>
            ))}
          </div>
        </label>
      </Panel>

      {/* Import dossier + préparation */}
      <Panel className="p-5 rise-in" style={{ animationDelay: "120ms" }}>
        <div className="flex items-center gap-2">
          <FolderInput className="size-4 text-cyan-hi" strokeWidth={2.25} />
          <h2 className="text-[0.95rem] font-semibold text-ink-1">Importer un dossier</h2>
        </div>
        {isCs202 ? (
          <p className="mt-2 text-[0.8rem] leading-relaxed text-ink-3">
            CS-202 lit ses sites de révision en lecture seule — l’import de dossier est réservé
            aux cours additionnels (Algo, ML…).
          </p>
        ) : (
          <>
            <p className="mt-1 text-[0.8rem] text-ink-3">
              Chemin d’un dossier local (finals, séries, slides) — Cortex classe et ingère.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                value={dirPath}
                onChange={(e) => setDirPath(e.target.value)}
                placeholder="/Users/…/ALGO 1"
                aria-label="Chemin du dossier à importer"
                className="min-w-0 flex-1 rounded-lg border border-line-strong bg-surface-2/40 px-3 py-2.5 font-mono text-[0.82rem] text-ink-1 placeholder:text-ink-4 focus:border-[color-mix(in_oklch,var(--color-violet)_50%,transparent)] focus:outline-none"
              />
              <Button variant="secondary" onClick={importFolder} disabled={!dirPath.trim() || running}>
                Importer
              </Button>
            </div>
          </>
        )}

        <div className="mt-5 border-t border-line pt-4">
          <Button variant="primary" onClick={prepare} loading={running && jobKind === "prepare"} disabled={running && jobKind !== "prepare"} className="w-full">
            {!(running && jobKind === "prepare") && <Sparkles className="size-4" strokeWidth={2.5} />}
            Préparer le cours
          </Button>
          <p className="mt-2 text-[0.76rem] leading-relaxed text-ink-3">
            Pipeline complet : ingestion du corpus → détection du format → types d’exos et poids.
          </p>
        </div>

        {/* progression de job (format / ingest / prepare) */}
        {running && job && (
          <div className="mt-4 rounded-lg border border-line bg-surface-2/30 px-3.5 py-3" aria-live="polite">
            <div className="mb-2 flex items-center justify-between text-[0.78rem]">
              <span className="text-ink-2">
                {asText(job.currentStep) ??
                  (jobKind === "prepare" ? "Préparation du cours…" : jobKind === "ingest" ? "Ingestion du dossier…" : "Détection du format…")}
              </span>
              <span className="font-data font-semibold text-ink-1">
                {job.status === "queued" ? "" : `${job.progress} %`}
              </span>
            </div>
            <WeightBar pct={job.status === "queued" ? 4 : job.progress} height={5} />
          </div>
        )}

        {uploadedMsg && (
          <p className="mt-3 inline-flex items-center gap-1.5 text-[0.8rem] text-emerald-hi" aria-live="polite">
            <Check className="size-4" strokeWidth={2.5} />
            {uploadedMsg}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 inline-flex items-start gap-1.5 text-[0.8rem] text-danger-hi">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.25} />
            {error}
          </p>
        )}
      </Panel>
    </div>
  );
}
