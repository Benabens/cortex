"use client";

import { useEffect, useRef, useState } from "react";
import { UploadCloud, Check, Sparkles, FolderInput, AlertTriangle } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { WeightBar } from "@/components/viz/WeightBar";
import { Segmented } from "@/components/ui/Segmented";
import { useCourse, useJob, JOB_ACTIVE, asText, type ApiError } from "@/lib/ux/api";
import { cn } from "@/lib/ux/cn";
import { PaywallNotice } from "@/components/billing/PaywallNotice";
import { UsageLine, useLaunchUsage } from "@/components/billing/UsageIndicator";
import { FOLDER_EXTENSIONS, prepareCourseImport, type FolderImportRefusal } from "@/lib/folder-import";
import { ingestProblems, type IngestProblem } from "@/lib/ingest-report";
import { apiDelete } from "@/lib/ux/write";

const ACCEPT = ".pdf,.docx,.pptx,.html,.htm,.txt,.md,.zip";
/** Annales : Word et PowerPoint en plus (lus comme le reste du cours). Autres zones : formats de /api/sources/add. */
const PAST_EXAM_FILES = /\.(pdf|docx|pptx|html?|txt|md)$/i;
const OTHER_FILES = /\.(pdf|html?|txt|md)$/i;
/** Un dossier de cours contient plus que des annales : slides, séries, images, notes. */
const ACCEPT_FOLDER_ATTRIBUTE = [...FOLDER_EXTENSIONS.map((ext) => `.${ext}`), ".zip"].join(",");

/**
 * Ce que sont les fichiers déposés. Une annale décide du format ; sans annale, les
 * questions d'exemple publiées par l'enseignant donnent le style des QCM, et les
 * consignes d'examen (syllabus, page Moodle) le format — lus à la préparation.
 */
type DropKind = "past_exam" | "sample_questions" | "exam_info";
const DROP_KINDS: { value: DropKind; label: string }[] = [
  { value: "past_exam", label: "Annales" },
  { value: "sample_questions", label: "Questions d’exemple" },
  { value: "exam_info", label: "Consignes d’examen" },
];

/**
 * Import UNIFIÉ — tout part du NAVIGATEUR, plus jamais d'un chemin sur le serveur :
 * — glisser des fichiers (annales, PDF) → POST /api/refs/upload (multipart) → ingestion + job « format » ;
 * — OU choisir un DOSSIER → POST /api/sources/import (multipart) → classement
 *   (finals dans refs/, slides et séries dans content/) puis job « ingest » ;
 * puis « Préparer le cours » → POST /api/prepare → pipeline complet (ingestion → format → blueprint).
 */
export function ImportPanel({ onChanged }: { onChanged: () => void }) {
  const { courseId } = useCourse();
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dropKind, setDropKind] = useState<DropKind>("past_exam");

  const [uploading, setUploading] = useState(false);
  const [uploadedMsg, setUploadedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState(false);
  const [folderProgress, setFolderProgress] = useState<{ done: number; total: number } | null>(null);
  const [folderRefusals, setFolderRefusals] = useState<FolderImportRefusal[]>([]);
  // Fichiers déposés que l'ingestion n'a pas pu lire : nommés un par un, avec quoi faire.
  const [unreadFiles, setUnreadFiles] = useState<IngestProblem[]>([]);
  const [jobId, setJobId] = useState<number | null>(null);
  const [jobKind, setJobKind] = useState<"format" | "ingest" | "prepare" | null>(null);
  const job = useJob(jobId);
  const running = jobId != null && (!job || JOB_ACTIVE.includes(job.status));
  // Même verdict que POST /api/prepare : le bouton est coupé avant le clic, raison à l'appui.
  const launch = useLaunchUsage("prepare");
  const { refresh: refreshUsage } = launch;
  useEffect(() => { if (!running) refreshUsage(); }, [running, refreshUsage]);
  const notified = useRef(false);

  useEffect(() => {
    setJobId(null);
    setJobKind(null);
    setError(null);
    setUploadedMsg(null);
    setFolderProgress(null);
    setFolderRefusals([]);
    setUnreadFiles([]);
    notified.current = false;
  }, [courseId]);

  useEffect(() => {
    if (!job || JOB_ACTIVE.includes(job.status) || notified.current) return;
    notified.current = true;
    setJobId(null);
    const unread = ingestProblems(job.report);
    setUnreadFiles(unread);
    if (job.status === "error" || job.status === "failed") {
      setError(asText(job.error) ?? "Le traitement a échoué. Réessaie.");
    } else {
      const skipped = unread.length
        ? ` ${unread.length} fichier${unread.length > 1 ? "s n’ont" : " n’a"} pas pu être lu${unread.length > 1 ? "s" : ""} : la liste est ci-dessous.`
        : "";
      setUploadedMsg(
        (jobKind === "prepare"
          ? "Cours préparé : types d’exos et poids mis à jour."
          : jobKind === "ingest"
            ? "Dossier ingéré : le corpus est à jour."
            : "Format re-détecté sur tes annales.") + skipped
      );
      onChanged();
    }
    setJobKind(null);
  }, [job, jobKind, onChanged]);

  /** Un fichier non lu ne compte nulle part : le retirer libère la place et allège la liste. */
  const removeUnread = async (item: IngestProblem) => {
    try {
      await apiDelete(`/api/sources?path=${encodeURIComponent(item.path)}&course=${encodeURIComponent(courseId)}`);
      setUnreadFiles((list) => list.filter((f) => f.path !== item.path));
    } catch (e) {
      setError(`${item.name} : retrait impossible (${(e as Error).message}).`);
    }
  };

  const startJob = (id: number, kind: "format" | "ingest" | "prepare") => {
    notified.current = false;
    setUnreadFiles([]);
    setJobId(id);
    setJobKind(kind);
  };

  const upload = async (files: FileList | File[]) => {
    if ([...files].some((file) => /\.zip$/i.test(file.name))) {
      await importFolder(files);
      return;
    }
    // Un glisser-déposer ignore l'attribut accept : les fichiers écartés ici sont nommés, pas perdus.
    const allowed = dropKind === "past_exam" ? PAST_EXAM_FILES : OTHER_FILES;
    const list = [...files].filter((f) => allowed.test(f.name));
    const refusedHere = [...files].filter((f) => !allowed.test(f.name)).map((f) => ({ name: f.name, reason: "format non pris en charge dans cette zone" }));
    setFolderRefusals(refusedHere);
    if (!list.length) {
      setError(dropKind === "past_exam" ? "Formats acceptés : PDF, Word, PowerPoint, HTML, TXT, MD." : "Formats acceptés : PDF, HTML, TXT, MD.");
      return;
    }
    setError(null);
    setUploadedMsg(null);
    setUnreadFiles([]);
    setUploading(true);
    try {
      const fd = new FormData();
      for (const f of list) fd.append("file", f);
      if (dropKind !== "past_exam") {
        // Questions d'exemple / consignes : rangées à part, puis ingérées avec le reste du cours.
        const res = await fetch(`/api/sources/add?course=${encodeURIComponent(courseId)}&category=${dropKind}`, { method: "POST", body: fd });
        const d = await res.json().catch(() => null);
        if (!res.ok) throw new Error(d?.error ?? `Erreur ${res.status}`);
        // « nom : raison », un par fichier refusé (cf. /api/sources/add).
        const refusedThere = ((d.skipped ?? []) as string[]).map((line) => {
          const at = line.indexOf(" : ");
          return at > 0 ? { name: line.slice(0, at), reason: line.slice(at + 3) } : { name: line, reason: "refusé" };
        });
        setFolderRefusals([...refusedHere, ...refusedThere]);
        setUploadedMsg(`${d.files} fichier${d.files > 1 ? "s" : ""} déposé${d.files > 1 ? "s" : ""}${refusedThere.length ? `, ${refusedThere.length} refusé${refusedThere.length > 1 ? "s" : ""}` : ""} : indexation… Relance « Préparer le cours » pour relire le format.`);
        startJob(d.jobId, "ingest");
        return;
      }
      const res = await fetch(`/api/refs/upload?course=${encodeURIComponent(courseId)}`, { method: "POST", body: fd });
      const d = await res.json().catch(() => null);
      const refusedThere = ((d?.skipped ?? []) as { file: string; reason: string }[]).map((s) => ({ name: s.file, reason: s.reason }));
      setFolderRefusals([...refusedHere, ...refusedThere]);
      if (!res.ok) throw new Error(d?.error ?? `Erreur ${res.status}`);
      setUploadedMsg(`${d.files.length} fichier${d.files.length > 1 ? "s" : ""} ingéré${d.files.length > 1 ? "s" : ""}${refusedThere.length ? `, ${refusedThere.length} écarté${refusedThere.length > 1 ? "s" : ""}` : ""}.`);
      onChanged();
      if (d.formatJobId) startJob(d.formatJobId, "format");
    } catch (e) {
      setError((e as Error).message || "L’upload a échoué.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  /**
   * Import d'un DOSSIER choisi dans le navigateur : on envoie les fichiers ET leur
   * chemin relatif — c'est lui qui permet au serveur de distinguer une annale d'un
   * support de cours. Les fichiers non exploitables sont filtrés ici pour ne pas
   * téléverser inutilement (le serveur refiltre de toute façon).
   */
  const importFolder = async (files: FileList | File[]) => {
    setError(null);
    setUploadedMsg(null);
    setUploading(true);
    setFolderProgress(null);
    try {
      const selection = await prepareCourseImport(files);
      setFolderRefusals(selection.rejected);
      if (!selection.accepted.length) {
        throw { status: 400, message: "Aucun fichier exploitable dans cette sélection. Vérifie les formats et les limites indiquées." } as ApiError;
      }
      setFolderProgress({ done: 0, total: selection.accepted.length });
      const refused = [...selection.rejected];
      let saved = 0;
      let duplicates = 0;
      for (const [index, entry] of selection.accepted.entries()) {
        let failure = "";
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const fd = new FormData();
            fd.append("file", entry.file);
            fd.append("relpath", entry.relativePath);
            const res = await fetch(`/api/sources/import?course=${encodeURIComponent(courseId)}`, { method: "POST", body: fd });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
              failure = data?.error ?? (res.status === 413 ? "fichier ou quota trop volumineux" : `erreur ${res.status}`);
              if (res.status < 500) break;
              continue;
            }
            if (data?.duplicate) duplicates++;
            else saved++;
            failure = "";
            break;
          } catch {
            failure = "connexion interrompue après 3 tentatives";
          }
        }
        if (failure) refused.push({ name: entry.relativePath, reason: failure });
        setFolderProgress({ done: index + 1, total: selection.accepted.length });
      }
      setFolderRefusals(refused);
      if (!saved && !duplicates) throw { status: 400, message: "Aucun fichier n’a pu être importé. Consulte la liste des refus ci-dessous." } as ApiError;
      const res = await fetch(`/api/sources/import?course=${encodeURIComponent(courseId)}&action=finish`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw { status: res.status, message: data?.error ?? `Erreur ${res.status}` } as ApiError;
      const already = duplicates ? `, ${duplicates} déjà présent${duplicates > 1 ? "s" : ""} dans le cours (même contenu)` : "";
      setUploadedMsg(`${saved} fichier${saved > 1 ? "s" : ""} déposé${saved > 1 ? "s" : ""}${already}${refused.length ? `, ${refused.length} refusé${refused.length > 1 ? "s" : ""}` : ""} : indexation…`);
      startJob(data.jobId, "ingest");
    } catch (e) {
      setError((e as ApiError).message || "L’import du dossier a échoué.");
    } finally {
      setUploading(false);
      if (folderRef.current) folderRef.current.value = "";
    }
  };

  const prepare = async () => {
    if (running) return;
    setError(null);
    setPaywall(false);
    setUploadedMsg(null);
    try {
      const res = await fetch(`/api/prepare?course=${encodeURIComponent(courseId)}`, { method: "POST" });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw { status: res.status, message: d?.error ?? `Erreur ${res.status}` } as ApiError;
      startJob(d.jobId, "prepare");
    } catch (e) {
      const err = e as ApiError;
      setPaywall(err.status === 402);
      setError(err.message || "Impossible de lancer la préparation.");
    }
  };

  return (
    <Panel className="flex flex-col gap-5 p-6">
      <h2 className="text-xl font-semibold text-ink-1">Importer</h2>

      <Segmented
        size="sm"
        label="Ces fichiers sont"
        options={DROP_KINDS}
        value={dropKind}
        onChange={setDropKind}
      />

      {/* Dropzone fichiers — glisser un examen / cours / PDF */}
      <label
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files); }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-4 py-8 text-center transition-colors",
          dragOver
            ? "border-[color-mix(in_oklch,var(--color-accent)_60%,transparent)] bg-[color-mix(in_oklch,var(--color-accent)_10%,transparent)]"
            : "border-line-strong bg-surface-2/30 hover:border-[color-mix(in_oklch,var(--color-accent)_45%,transparent)]"
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
          className="grid size-11 place-items-center rounded-2xl"
          style={{ background: "var(--tile-bg)", color: "var(--tile-ink)", boxShadow: "var(--shadow-card), var(--tile-edge)" }}
        >
          <UploadCloud className="size-5" strokeWidth={2} />
        </span>
        <div>
          <p className="text-[0.92rem] font-semibold text-ink-1">
            {uploading
              ? "Téléversement en cours…"
              : dropKind === "past_exam"
                ? "Glisse un examen, un cours, un PDF"
                : dropKind === "sample_questions"
                  ? "Glisse les questions d’exemple de l’enseignant"
                  : "Glisse les consignes d’examen (syllabus, page du cours)"}
          </p>
          <p className="mt-0.5 text-[0.8rem] text-ink-3">ou clique pour parcourir</p>
        </div>
        <div className="flex flex-wrap justify-center gap-1.5">
          {(dropKind === "past_exam" ? ["PDF", "Word", "PowerPoint", "HTML", "TXT", "MD", "ZIP"] : ["PDF", "HTML", "TXT", "MD", "ZIP"]).map((f) => (
            <span key={f} className="rounded-md border border-line bg-surface-1/60 px-2 py-0.5 font-data text-xs text-ink-3">{f}</span>
          ))}
        </div>
      </label>

      {/* OU un dossier complet, choisi dans le navigateur */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="h-px flex-1 bg-line" />
          <span className="text-[0.72rem] text-ink-4">ou un dossier complet</span>
          <span className="h-px flex-1 bg-line" />
        </div>
        <input
          ref={folderRef}
          type="file"
          multiple
          accept={ACCEPT_FOLDER_ATTRIBUTE}
          // Sélection d'un dossier entier : attribut non standard mais supporté par
          // tous les navigateurs de bureau ; React exige la casse DOM exacte.
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          aria-label="Dossier de cours à importer"
          tabIndex={-1}
          className="sr-only"
          onChange={(e) => e.target.files && importFolder(e.target.files)}
        />
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => folderRef.current?.click()}
          disabled={uploading || running}
        >
          <FolderInput className="size-4" strokeWidth={2.25} />
          Choisir un dossier de cours
        </Button>
        {uploading && folderProgress && (
          <p className="mt-2 text-[0.8rem] font-medium text-ink-2" aria-live="polite">
            Envoi de {folderProgress.done}/{folderProgress.total} fichiers…
          </p>
        )}
        <p className="mt-2 text-[0.76rem] leading-relaxed text-ink-3">
          Finals et midterms vont dans tes annales : ce sont eux qui fixent le format. Slides,
          séries, documents Word et notes rejoignent le reste du cours. 30 Mo maximum par
          fichier, dans la limite de stockage de ton compte. Les ZIP sont décompressés dans ton
          navigateur, même s’ils contiennent une autre archive.
        </p>
      </div>

      {/* Préparer le cours (pipeline complet) */}
      <div className="border-t border-line pt-4">
        <Button variant="primary" onClick={prepare} loading={running && jobKind === "prepare"} disabled={(running && jobKind !== "prepare") || (!running && !launch.allowed)} className="w-full">
          {!(running && jobKind === "prepare") && <Sparkles className="size-4" strokeWidth={2.5} />}
          Préparer le cours
        </Button>
        {!running && <UsageLine usage={launch.usage} now={launch.now} className="mt-2" />}
        <p className="mt-2 text-[0.76rem] leading-relaxed text-ink-3">
          Cortex lit tes supports, reconnaît le format du final et organise les notions à travailler.
        </p>
      </div>

      {/* progression de job (format / ingest / prepare) */}
      {paywall && <PaywallNotice credits={2} />}
      {running && job && (
        <div className="rounded-lg border border-line bg-surface-2/30 px-3.5 py-3" aria-live="polite">
          <div className="mb-2 flex items-center justify-between text-[0.78rem]">
            <span className="text-ink-2">
              {asText(job.currentStep) ??
                (jobKind === "prepare" ? "Préparation du cours…" : jobKind === "ingest" ? "Ingestion du dossier…" : "Détection du format…")}
            </span>
            <span className="font-data font-semibold text-ink-1">{job.status === "queued" ? "" : `${job.progress} %`}</span>
          </div>
          <WeightBar pct={job.status === "queued" ? 4 : job.progress} height={5} />
        </div>
      )}

      {uploadedMsg && (
        <p className="inline-flex items-center gap-1.5 text-[0.8rem] text-emerald-hi" aria-live="polite">
          <Check className="size-4" strokeWidth={2.5} />
          {uploadedMsg}
        </p>
      )}
      {error && (
        <p role="alert" className="inline-flex items-start gap-1.5 text-[0.8rem] text-danger-hi">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2.25} />
          {error}
        </p>
      )}
      {folderRefusals.length > 0 && (
        <div className="rounded-lg border border-line bg-surface-2/30 px-3.5 py-3 text-[0.78rem] text-ink-3">
          <p className="font-semibold text-ink-2">Fichiers non importés</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            {folderRefusals.map((item, index) => <li key={`${item.name}-${index}`}><span className="break-all">{item.name}</span> : {item.reason}</li>)}
          </ul>
        </div>
      )}
      {unreadFiles.length > 0 && (
        <div className="rounded-lg border border-line bg-surface-2/30 px-3.5 py-3 text-[0.78rem] text-ink-3" role="status">
          <p className="font-semibold text-ink-2">Fichiers non lus</p>
          <p className="mt-0.5">Les autres fichiers du cours ont été lus normalement.</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            {unreadFiles.map((item) => (
              <li key={item.path}>
                <span className="break-all font-medium text-ink-2">{item.name}</span> : {item.message}{" "}
                <button type="button" onClick={() => removeUnread(item)} className="font-medium text-ink-2 underline underline-offset-2 hover:text-ink-1">
                  Retirer du cours
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
