"use client";

import { useEffect, useRef, useState } from "react";
import { UploadCloud, Check, Sparkles, FolderInput, AlertTriangle } from "lucide-react";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { GenerationProgress } from "@/components/generation/GenerationProgress";
import { useJobError } from "@/components/generation/useJobError";
import { notifyJobStarted } from "@/lib/ux/generation-tracker";
import { Segmented } from "@/components/ui/Segmented";
import { useCourse, useJob, findActiveJob, JOB_ACTIVE, jobEnd, asText, type ApiError } from "@/lib/ux/api";
import { cn } from "@/lib/ux/cn";
import { LocalImportNote } from "@/components/sources/OriginalsNotes";
import { PaywallNotice } from "@/components/billing/PaywallNotice";
import { UsageLine, useLaunchUsage } from "@/components/billing/UsageIndicator";
import { ARCHIVE_FILE, FOLDER_EXTENSIONS, prepareCourseImport, type FolderImportRefusal } from "@/lib/folder-import";
import { ingestProblems, type IngestProblem } from "@/lib/ingest-report";
import { apiDelete } from "@/lib/ux/write";
import type { OriginalsInfo } from "@/lib/ux/sources";
import { useLocale, useTranslations } from "use-intl/react";

const ACCEPT = ".pdf,.docx,.pptx,.html,.htm,.txt,.md,.zip,.imscc,.mbz";
/** Annales : Word et PowerPoint en plus (lus comme le reste du cours). Autres zones : formats de /api/sources/add. */
const PAST_EXAM_FILES = /\.(pdf|docx|pptx|html?|txt|md)$/i;
const OTHER_FILES = /\.(pdf|html?|txt|md)$/i;
/** Un dossier de cours contient plus que des annales : slides, séries, images, notes. */
const ACCEPT_FOLDER_ATTRIBUTE = [...FOLDER_EXTENSIONS.map((ext) => `.${ext}`), ".zip", ".imscc", ".mbz"].join(",");

/**
 * Ce que sont les fichiers déposés. Une annale décide du format ; sans annale, les
 * questions d'exemple publiées par l'enseignant donnent le style des QCM, et les
 * consignes d'examen (syllabus, page Moodle) le format — lus à la préparation.
 */
type DropKind = "past_exam" | "sample_questions" | "exam_info";
/** « scan » : l'ingestion lancée par un dépôt d'annale scannée, qui la lit par OCR. */
type JobKind = "format" | "ingest" | "prepare" | "scan";
/**
 * Import UNIFIÉ — tout part du NAVIGATEUR, plus jamais d'un chemin sur le serveur :
 * — glisser des fichiers (annales, PDF) → POST /api/refs/upload (multipart) → ingestion, gratuite ;
 *   relire le format sur ces annales (payant) est proposé ensuite, coût affiché, → POST /api/refs/format ;
 * — OU choisir un DOSSIER → POST /api/sources/import (multipart) → classement
 *   (finals dans refs/, slides et séries dans content/) puis job « ingest » ;
 * puis « Préparer le cours » → POST /api/prepare → pipeline complet (ingestion → format → blueprint).
 */
export function ImportPanel({ onChanged, unread, originals }: { onChanged: () => void; unread?: IngestProblem[]; originals?: OriginalsInfo | null }) {
  const t = useTranslations("import");
  const locale = useLocale();
  const dropKinds: { value: DropKind; label: string }[] = [
    { value: "past_exam", label: t("pastExams") },
    { value: "sample_questions", label: t("sampleQuestions") },
    { value: "exam_info", label: t("examInstructions") },
  ];
  const { courseId } = useCourse();
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dropKind, setDropKind] = useState<DropKind>("past_exam");

  const [uploading, setUploading] = useState(false);
  const [uploadedMsg, setUploadedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Refus 402 et son code (la limite des crédits offerts n'est pas un solde vide) ; null : pas de refus.
  const [paywall, setPaywall] = useState<{ code: string | null } | null>(null);
  const [folderProgress, setFolderProgress] = useState<{ done: number; total: number } | null>(null);
  const [folderRefusals, setFolderRefusals] = useState<FolderImportRefusal[]>([]);
  // Fichiers déposés que l'ingestion n'a pas pu lire : nommés un par un, avec quoi faire.
  const [unreadFiles, setUnreadFiles] = useState<IngestProblem[]>([]);
  // La liste du serveur (dernier rapport, fichiers encore rangés) : elle survit au rechargement.
  const [serverUnread, setServerUnread] = useState(unread);
  if (unread !== serverUnread) {
    setServerUnread(unread);
    if (unread) setUnreadFiles(unread);
  }
  const [jobId, setJobId] = useState<number | null>(null);
  const [jobKind, setJobKind] = useState<JobKind | null>(null);
  const job = useJob(jobId);
  const jobError = useJobError();
  const running = jobId != null && (!job || JOB_ACTIVE.includes(job.status));
  // Même verdict que POST /api/prepare : le bouton est coupé avant le clic, raison à l'appui.
  const launch = useLaunchUsage("prepare");
  const { refresh: refreshUsage } = launch;
  // Relire le format est payant : son coût est dit AVANT le dépôt et sur le bouton, le débit après.
  const formatLaunch = useLaunchUsage("format");
  const { refresh: refreshFormatUsage } = formatLaunch;
  const formatCost = formatLaunch.usage?.costCredits ?? 0;
  // remaining null : aucune limite du jour ne compte cette détection (propriétaire, instance sans quota).
  const creditCost = formatCost > 0 ? t("creditCost", { count: formatCost }) : null;
  const dailyQuota = formatLaunch.usage && formatLaunch.usage.remaining !== null ? t("dailyGeneration") : null;
  const formatPrice = creditCost && dailyQuota ? t("costAndQuota", { cost: creditCost, quota: dailyQuota }) : creditCost ?? dailyQuota;
  const [formatOffer, setFormatOffer] = useState(false);
  const [formatCharged, setFormatCharged] = useState(0);
  useEffect(() => { if (!running) { refreshUsage(); refreshFormatUsage(); } }, [running, refreshUsage, refreshFormatUsage]);
  const notified = useRef(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- changer de cours réinitialise atomiquement ce panneau local
    setJobId(null);
    setJobKind(null);
    setError(null);
    setUploadedMsg(null);
    setFolderProgress(null);
    setFolderRefusals([]);
    setFormatOffer(false);
    setFormatCharged(0);
    setUnreadFiles([]);
    notified.current = false;
    // Une préparation, une lecture ou une détection lancée avant (page quittée, rechargement) : son suivi reprend ici.
    let alive = true;
    if (courseId) {
      void findActiveJob(courseId, ["prepare", "ingest", "format"]).then((j) => {
        if (!alive || !j) return;
        setJobId(j.id);
        setJobKind(j.type as JobKind);
      });
    }
    return () => { alive = false; };
  }, [courseId]);

  useEffect(() => {
    if (!job || JOB_ACTIVE.includes(job.status) || notified.current) return;
    notified.current = true;
    setJobId(null);
    // Un job de format n'a pas de rapport : la liste en cours reste affichée.
    const unread = ingestProblems(job.report, locale);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- la fin du job publie son rapport dans l'état du panneau
    if (job.report) setUnreadFiles(unread);
    const end = jobEnd(job.status);
    if (end === "failed") {
      setError(jobError(job.error) ?? t("jobFailed"));
    } else if (end === "canceled") {
      setUploadedMsg(t("jobCanceled"));
      onChanged();
    } else {
      const skipped = unread.length ? t("unreadSuffix", { count: unread.length }) : "";
      setUploadedMsg(
        (jobKind === "prepare"
          ? t("prepared")
          : jobKind === "ingest"
            ? t("folderIngested")
            : jobKind === "scan"
              ? t("scansRead")
            : t("formatDetected", { charged: formatCharged > 0 ? ` (${t("debited", { count: formatCharged })})` : "" })) + skipped
      );
      onChanged();
    }
    setJobKind(null);
  }, [job, jobKind, onChanged, formatCharged, t, locale, jobError]);

  /** Un fichier non lu ne compte nulle part : le retirer libère la place et allège la liste. */
  const removeUnread = async (item: IngestProblem) => {
    try {
      await apiDelete(`/api/sources?path=${encodeURIComponent(item.path)}&course=${encodeURIComponent(courseId)}`);
      setUnreadFiles((list) => list.filter((f) => f.path !== item.path));
    } catch (e) {
      setError(t("removeUnreadFailed", { name: item.name, error: (e as Error).message }));
    }
  };

  const startJob = (id: number, kind: JobKind) => {
    notified.current = false;
    if (kind !== "format") setUnreadFiles([]);
    setJobId(id);
    setJobKind(kind);
    notifyJobStarted();
  };

  const upload = async (files: FileList | File[]) => {
    // Cours pas encore résolu (liste des cours en vol) : un envoi partirait avec `course=` vide, que
    // le serveur lit comme le cours par défaut (refus « Cours inconnu », ou fichier rangé ailleurs).
    if (!courseId) return;
    if ([...files].some((file) => ARCHIVE_FILE.test(file.name))) {
      await importFolder(files);
      return;
    }
    // Un glisser-déposer ignore l'attribut accept : les fichiers écartés ici sont nommés, pas perdus.
    const allowed = dropKind === "past_exam" ? PAST_EXAM_FILES : OTHER_FILES;
    const list = [...files].filter((f) => allowed.test(f.name));
    const refusedHere = [...files].filter((f) => !allowed.test(f.name)).map((f) => ({ name: f.name, reason: t("unsupportedHere") }));
    setFolderRefusals(refusedHere);
    if (!list.length) {
      setError(dropKind === "past_exam" ? t("acceptedPastExams") : t("acceptedOthers"));
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
        if (!res.ok) throw new Error(d?.error ?? t("errorStatus", { status: res.status }));
        // « nom : raison » (français) ou "name: reason" (anglais), un par fichier refusé (cf. fileErrorText).
        const refusedThere = ((d.skipped ?? []) as string[]).map((line) => {
          const at = line.indexOf(": ");
          return at > 0 ? { name: line.slice(0, at).trimEnd(), reason: line.slice(at + 2) } : { name: line, reason: t("refused") };
        });
        setFolderRefusals([...refusedHere, ...refusedThere]);
        setUploadedMsg(t("filesAdded", { count: d.files, refused: refusedThere.length ? t("refusedSuffix", { count: refusedThere.length }) : "" }));
        startJob(d.jobId, "ingest");
        return;
      }
      const res = await fetch(`/api/refs/upload?course=${encodeURIComponent(courseId)}`, { method: "POST", body: fd });
      const d = await res.json().catch(() => null);
      const refusedThere = ((d?.skipped ?? []) as { file: string; reason: string }[]).map((s) => ({ name: s.file, reason: s.reason }));
      setFolderRefusals([...refusedHere, ...refusedThere]);
      if (!res.ok) throw new Error(d?.error ?? t("errorStatus", { status: res.status }));
      const refusedSuffix = refusedThere.length ? t("skippedSuffix", { count: refusedThere.length }) : "";
      if (typeof d.jobId === "number") {
        // Annale scannée : le job d'ingestion la lit par OCR, son rapport dira ce qui reste illisible.
        startJob(d.jobId, "scan");
        setUploadedMsg(t("filesIngestedOcr", { count: d.files.length, refused: refusedSuffix }));
        onChanged();
        if (d.formatPending) setFormatOffer(true);
        return;
      }
      const unread = (d.unread ?? []) as IngestProblem[];
      setUnreadFiles(unread);
      setUploadedMsg(t("filesIngested", {
        count: d.files.length,
        refused: refusedSuffix,
        unread: unread.length ? t("unreadListSuffix", { count: unread.length }) : "",
      }));
      onChanged();
      if (d.formatPending) setFormatOffer(true);
    } catch (e) {
      setError((e as Error).message || t("uploadFailed"));
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
    if (!courseId) return; // même garde que upload()
    setError(null);
    setUploadedMsg(null);
    setUploading(true);
    setFolderProgress(null);
    try {
      const selection = await prepareCourseImport(files);
      setFolderRefusals(selection.rejected);
      if (!selection.accepted.length) {
        throw { status: 400, message: t("noUsableFile") } as ApiError;
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
              failure = data?.error ?? (res.status === 413 ? t("tooLarge") : t("lowerErrorStatus", { status: res.status }));
              if (res.status < 500) break;
              continue;
            }
            if (data?.duplicate) duplicates++;
            else saved++;
            failure = "";
            break;
          } catch {
            failure = t("connectionInterrupted");
          }
        }
        if (failure) refused.push({ name: entry.relativePath, reason: failure });
        setFolderProgress({ done: index + 1, total: selection.accepted.length });
      }
      setFolderRefusals(refused);
      if (!saved && !duplicates) throw { status: 400, message: t("noImportedFile") } as ApiError;
      const res = await fetch(`/api/sources/import?course=${encodeURIComponent(courseId)}&action=finish`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw { status: res.status, message: data?.error ?? t("errorStatus", { status: res.status }) } as ApiError;
      const already = duplicates ? t("duplicateSuffix", { count: duplicates }) : "";
      setUploadedMsg(t("filesUploaded", { count: saved, duplicates: already, refused: refused.length ? t("refusedSuffix", { count: refused.length }) : "" }));
      startJob(data.jobId, "ingest");
    } catch (e) {
      setError((e as ApiError).message || t("folderImportFailed"));
    } finally {
      setUploading(false);
      if (folderRef.current) folderRef.current.value = "";
    }
  };

  /** Relire le format sur les annales déposées : lancé ici, jamais par le dépôt lui-même. */
  const detectFormat = async () => {
    if (running) return;
    setError(null);
    setPaywall(null);
    setUploadedMsg(null);
    try {
      const res = await fetch(`/api/refs/format?course=${encodeURIComponent(courseId)}`, { method: "POST" });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw { status: res.status, message: d?.error ?? t("errorStatus", { status: res.status }), code: d?.code ?? null } as ApiError;
      setFormatOffer(false);
      const charged = Number(d.chargedCredits) || 0;
      setFormatCharged(charged);
      setUploadedMsg(t("formatStarted", { charged: charged > 0 ? t("debitedSuffix", { debited: t("debited", { count: charged }) }) : "" }));
      if (d.jobId) startJob(d.jobId, "format");
    } catch (e) {
      const err = e as ApiError;
      setPaywall(err.status === 402 ? { code: err.code } : null);
      setError(err.message || t("formatStartFailed"));
    }
  };

  const prepare = async () => {
    if (running) return;
    setError(null);
    setPaywall(null);
    setUploadedMsg(null);
    try {
      const res = await fetch(`/api/prepare?course=${encodeURIComponent(courseId)}`, { method: "POST" });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw { status: res.status, message: d?.error ?? t("errorStatus", { status: res.status }), code: d?.code ?? null } as ApiError;
      startJob(d.jobId, "prepare");
    } catch (e) {
      const err = e as ApiError;
      setPaywall(err.status === 402 ? { code: err.code } : null);
      setError(err.message || t("prepareFailed"));
    }
  };

  return (
    <Panel className="flex flex-col gap-5 p-6">
      <h2 className="text-xl font-semibold text-ink-1">{t("title")}</h2>

      <Segmented
        size="sm"
        label={t("fileKind")}
        options={dropKinds}
        value={dropKind}
        onChange={setDropKind}
      />

      {/* Dropzone fichiers — glisser un examen / cours / PDF */}
      <label
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files); }}
        aria-disabled={!courseId || undefined}
        className={cn(
          !courseId && "cursor-wait opacity-60",
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
          disabled={!courseId}
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
              ? t("uploading")
              : !courseId
                ? t("loadingCourse")
                : dropKind === "past_exam"
                ? t("dropPastExam")
                : dropKind === "sample_questions"
                  ? t("dropSampleQuestions")
                  : t("dropInstructions")}
          </p>
          <p className="mt-0.5 text-[0.8rem] text-ink-3">{t("browse")}</p>
          {dropKind === "past_exam" && (
            <p data-testid="annale-cost" className="mt-1.5 text-[0.76rem] text-ink-3">
              {formatPrice
                ? t("freeDepositWithCost", { price: formatPrice })
                : t("freeDeposit")}
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-center gap-1.5">
          {(dropKind === "past_exam" ? ["PDF", "Word", "PowerPoint", "HTML", "TXT", "MD", "ZIP"] : ["PDF", "HTML", "TXT", "MD", "ZIP"]).map((f) => (
            <span key={f} className="rounded-md border border-line bg-surface-1/60 px-2 py-0.5 font-data text-xs text-ink-3">{f}</span>
          ))}
        </div>
      </label>

      {/* Compte gratuit : le fichier ne reste pas sur le serveur (lib/originals) */}
      {originals?.home === "local" && <LocalImportNote transitHours={originals.transitHours} />}

      {/* OU un dossier complet, choisi dans le navigateur */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="h-px flex-1 bg-line" />
          <span className="text-[0.72rem] text-ink-4">{t("orFolder")}</span>
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
          aria-label={t("folderLabel")}
          tabIndex={-1}
          className="sr-only"
          onChange={(e) => e.target.files && importFolder(e.target.files)}
        />
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => folderRef.current?.click()}
          disabled={uploading || running || !courseId}
        >
          <FolderInput className="size-4" strokeWidth={2.25} />
          {t("chooseFolder")}
        </Button>
        {uploading && folderProgress && (
          <p className="mt-2 text-[0.8rem] font-medium text-ink-2" aria-live="polite">
            {t("sendingFiles", { done: folderProgress.done, total: folderProgress.total })}
          </p>
        )}
        <p className="mt-2 text-[0.76rem] leading-relaxed text-ink-3">
          {t("folderHint")}
        </p>
      </div>

      {/* Relire le format sur les annales qu'on vient de déposer (payant, à la demande) */}
      {formatOffer && !running && (
        <div className="rounded-lg border border-line bg-surface-2/30 px-3.5 py-3">
          <p className="text-[0.8rem] leading-relaxed text-ink-2">
            {t("formatOffer")}
          </p>
          <Button variant="secondary" size="md" onClick={detectFormat} disabled={!formatLaunch.allowed} className="mt-2.5 w-full">
            {formatCost > 0 ? t("detectFormatWithCost", { cost: t("creditCost", { count: formatCost }) }) : t("detectFormat")}
          </Button>
          <UsageLine usage={formatLaunch.usage} now={formatLaunch.now} className="mt-2" />
        </div>
      )}

      {/* Préparer le cours (pipeline complet) */}
      <div className="border-t border-line pt-4">
        <Button variant="primary" onClick={prepare} loading={running && jobKind === "prepare"} disabled={(running && jobKind !== "prepare") || (!running && !launch.allowed)} className="w-full">
          {!(running && jobKind === "prepare") && <Sparkles className="size-4" strokeWidth={2.5} />}
          {t("prepare")}
        </Button>
        {!running && <UsageLine usage={launch.usage} now={launch.now} className="mt-2" />}
        <p className="mt-2 text-[0.76rem] leading-relaxed text-ink-3">
          {t("prepareHint")}
        </p>
      </div>

      {/* progression de job (format / ingest / prepare) */}
      {paywall && <PaywallNotice credits={2} code={paywall.code} />}
      {running && (
        <GenerationProgress
          job={job && { ...job, currentStep: asText(job.currentStep) ?? (jobKind === "prepare" ? t("preparing") : jobKind === "ingest" || jobKind === "scan" ? t("ingesting") : t("detecting")) }}
          // Seule la préparation est payante et longue : l'annuler rend les crédits selon l'avancement.
          cancelable={jobKind === "prepare"}
          meanwhile={false}
        />
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
          <p className="font-semibold text-ink-2">{t("notImported")}</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            {folderRefusals.map((item, index) => <li key={`${item.name}-${index}`}>{t.rich("refusedItem", { name: (chunks) => <span className="break-all">{chunks}</span>, reason: item.reason, fileName: item.name })}</li>)}
          </ul>
        </div>
      )}
      {unreadFiles.length > 0 && (
        <div className="rounded-lg border border-line bg-surface-2/30 px-3.5 py-3 text-[0.78rem] text-ink-3" role="status">
          <p className="font-semibold text-ink-2">{t("unread")}</p>
          <p className="mt-0.5">{t("unreadHint")}</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            {unreadFiles.map((item) => (
              <li key={item.path}>
                {t.rich("refusedItem", { name: (chunks) => <span className="break-all font-medium text-ink-2">{chunks}</span>, fileName: item.name, reason: item.message })}{" "}
                <button type="button" onClick={() => removeUnread(item)} className="font-medium text-ink-2 underline underline-offset-2 hover:text-ink-1">
                  {t("removeFromCourse")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
