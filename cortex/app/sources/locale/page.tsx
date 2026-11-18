"use client";

import { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, FolderOpen, HardDrive, Upload } from "lucide-react";
import styles from "@/app/secondary.module.css";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { PREMIUM_HREF } from "@/components/sources/OriginalsNotes";
import { useApi, useCourse } from "@/lib/ux/api";
import type { LocalOriginal } from "@/lib/originals/registry";
import type { OriginalsNotice } from "@/lib/originals/retention";
import {
  findLocalFile, folderAccess, localFilesSupported, pickFolder, saveFolder, savedFolder, viewableType,
  type DirHandle, type WantedFile,
} from "@/lib/ux/local-file";
import { useTranslations } from "use-intl/react";
import { useFmt } from "@/lib/i18n/use-fmt";

/**
 * OUVRIR UN FICHIER RESTÉ SUR L'ORDINATEUR (compte gratuit, lib/originals). Les liens « Voir » d'un
 * fichier dont Cortex n'a gardé que l'index arrivent ici (/csrc et /refs redirigent, #page=N
 * compris). Chrome et Edge sur ordinateur : l'étudiant choisit une fois le dossier du cours, Cortex
 * y retrouve le fichier (nom + empreinte) et l'ouvre, sans rien envoyer. Ailleurs : où le trouver,
 * et l'offre Premium. Le fichier peut aussi être renvoyé (même empreinte) : au cloud en Premium,
 * le temps d'une préparation sinon.
 */

type Original = WantedFile & Pick<LocalOriginal, "origin" | "url" | "state">;
type Resp = { original: Original; plan: OriginalsNotice };

type Step =
  | { s: "checking" }
  | { s: "unsupported" }
  | { s: "pick" }
  | { s: "allow"; dir: DirHandle }
  | { s: "searching"; dir: string }
  | { s: "found"; file: File; where: string; dir: string; viewable: boolean }
  | { s: "changed"; where: string; dir: string }
  | { s: "missing"; dir: string };

const noSubscribe = () => () => {};
const subscribeHash = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export default function LocalOriginalPage() {
  return (
    <Suspense fallback={null}>
      <LocalOriginal />
    </Suspense>
  );
}

function LocalOriginal() {
  const t = useTranslations("localSource");
  const f = useFmt();
  const { courseId } = useCourse();
  const p = useSearchParams().get("p");
  // #page=N : gardé par la redirection de /csrc, jamais vu par le serveur.
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => "");
  const page = hash.startsWith("#page=") ? hash : "";
  const supported = useSyncExternalStore(noSubscribe, localFilesSupported, () => true);
  const { data, loading, error } = useApi<Resp>(p ? `/api/sources/originals?p=${encodeURIComponent(p)}` : null);
  const original = data?.original ?? null;
  const [step, setStep] = useState<Step>({ s: "checking" });

  const open = useCallback((file: File) => {
    const type = viewableType(file.name);
    if (!type) return;
    window.location.assign(URL.createObjectURL(new Blob([file], { type })) + (type === "application/pdf" ? page : ""));
  }, [page]);

  const search = useCallback(async (dir: DirHandle, auto: boolean) => {
    if (!original) return;
    setStep({ s: "searching", dir: dir.name });
    const r = await findLocalFile(dir, original);
    if (r.status === "found") {
      const viewable = !!viewableType(r.file.name);
      setStep({ s: "found", file: r.file, where: r.where, dir: dir.name, viewable });
      if (auto && viewable) open(r.file);
    } else if (r.status === "changed") setStep({ s: "changed", where: r.where, dir: dir.name });
    else setStep({ s: "missing", dir: dir.name });
  }, [original, open]);

  // Dossier déjà choisi pour ce cours, accès encore accordé : recherche et ouverture directes.
  useEffect(() => {
    if (!original || !courseId || !supported) return;
    if (original.origin === "text") return;
    let live = true;
    void (async () => {
      const dir = await savedFolder(courseId);
      if (!live) return;
      if (!dir) { setStep({ s: "pick" }); return; }
      if (await folderAccess(dir, false)) await search(dir, true);
      else if (live) setStep({ s: "allow", dir });
    })();
    return () => { live = false; };
  }, [original, courseId, supported, search]);

  const choose = async () => {
    const dir = await pickFolder();
    if (!dir) return;
    await saveFolder(courseId, dir);
    await search(dir, true);
  };
  const allow = async (dir: DirHandle) => {
    if (await folderAccess(dir, true)) await search(dir, true);
  };

  const name = original?.name ?? "";
  const local = data?.plan.home === "local";

  return (
    <div className={styles.page}>
      <PageHeader
        title={original ? t("titleNamed", { name }) : t("title")}
        description={t("description")}
      />
      <div className="flex w-full max-w-2xl flex-col gap-4">
        {loading && !data ? (
          <div className="skeleton h-48 rounded-lg" role="status" aria-busy="true" aria-label={t("loading")} />
        ) : error || !original ? (
          <Panel className="p-6 text-[0.9rem] text-ink-2">
            {error?.message ?? t("notLocal")}
          </Panel>
        ) : (
          <>
            <Panel className="flex flex-col gap-4 p-6">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-line bg-surface-2/60 text-ink-3">
                  <HardDrive className="size-5" strokeWidth={2} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink-1" title={name}>{name}</p>
                  <p className="text-[0.8rem] text-ink-3">
                    {original.rel && original.rel !== name ? t.rich("importedFrom", { value: original.rel, path: (chunks) => <span className="font-data break-all">{chunks}</span> }) : null}
                    {original.size >= 1024 * 1024
                      ? t("sizeMb", { size: f.number(original.size / 1024 / 1024, 1) })
                      : t("sizeKb", { size: f.number(Math.max(1, Math.round(original.size / 1024)), 0) })}
                    {page ? ` · ${t("page", { page: page.replace("#page=", "") })}` : ""}
                  </p>
                </div>
              </div>

              <StepView step={supported ? step : { s: "unsupported" }} original={original} page={page} onChoose={choose} onAllow={allow} onOpen={open} />

              {original.url && (
                <a href={original.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[0.85rem] font-medium text-accent-hi underline underline-offset-4">
                  {t("openOrigin")} <ArrowUpRight className="size-3.5" strokeWidth={2.25} aria-hidden="true" />
                </a>
              )}
            </Panel>

            {original.origin !== "text" && (
              <SendBack courseId={courseId} original={original} local={local} hours={data?.plan.transitHours ?? 24} found={step.s === "found" ? step.file : null} />
            )}

            {local && (
              <p className="text-[0.82rem] leading-relaxed text-ink-3">
                <a href={PREMIUM_HREF} className="font-medium text-accent-hi underline underline-offset-4">{t("premiumLink")}</a>{" "}
                {t("premiumHint")}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StepView({ step, original, page, onChoose, onAllow, onOpen }: {
  step: Step; original: Original; page: string;
  onChoose: () => void; onAllow: (dir: DirHandle) => void; onOpen: (f: File) => void;
}) {
  const t = useTranslations("localSource");
  const where = original.rel ?? original.name;
  if (original.origin === "text") {
    return <p className="text-[0.88rem] leading-relaxed text-ink-2">{t("textOnly")}</p>;
  }
  switch (step.s) {
    case "checking":
    case "searching":
      return (
        <p className="text-[0.88rem] text-ink-2" aria-live="polite">
          {step.s === "searching" ? t("searching", { name: original.name, folder: step.dir }) : t("wait")}
        </p>
      );
    case "unsupported":
      return (
        <p className="text-[0.88rem] leading-relaxed text-ink-2">
          {t.rich("unsupported", {
            where, page: page ? `, ${t("page", { page: page.replace("#page=", "") })}` : "",
            path: (chunks) => <span className="font-data break-all text-ink-1">{chunks}</span>,
          })}
        </p>
      );
    case "pick":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-[0.88rem] leading-relaxed text-ink-2">
            {t("pickHint")}
          </p>
          <Button variant="primary" onClick={onChoose} className="self-start">
            <FolderOpen className="size-4" strokeWidth={2.25} aria-hidden="true" />
            {t("pickFolder")}
          </Button>
        </div>
      );
    case "allow":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-[0.88rem] leading-relaxed text-ink-2">{t("allowHint", { folder: step.dir.name })}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => onAllow(step.dir)}>{t("allow")}</Button>
            <Button variant="ghost" onClick={onChoose}>{t("pickOther")}</Button>
          </div>
        </div>
      );
    case "found":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-[0.88rem] text-ink-2">
            {t.rich("found", { folder: step.dir, where: step.where, path: (chunks) => <span className="font-data break-all text-ink-1">{chunks}</span> })}
          </p>
          {step.viewable ? (
            <Button variant="primary" onClick={() => onOpen(step.file)} className="self-start">{t("openFile", { name: original.name })}</Button>
          ) : (
            <p className="text-[0.85rem] text-ink-3">{t("openWithApp")}</p>
          )}
        </div>
      );
    case "changed":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-[0.88rem] leading-relaxed text-ink-2">
            {t.rich("changed", { folder: step.dir, name: original.name, where: step.where, path: (chunks) => <span className="font-data break-all">{chunks}</span> })}
          </p>
          <Button variant="ghost" onClick={onChoose} className="self-start">{t("pickOther")}</Button>
        </div>
      );
    case "missing":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-[0.88rem] leading-relaxed text-ink-2">
            {t.rich("missing", { name: original.name, folder: step.dir, where, path: (chunks) => <span className="font-data break-all text-ink-1">{chunks}</span> })}
          </p>
          <Button variant="secondary" onClick={onChoose} className="self-start">{t("pickOther")}</Button>
        </div>
      );
  }
}

/** Renvoyer le même fichier : au cloud (Premium), ou le temps d'une préparation (gratuit). */
function SendBack({ courseId, original, local, hours, found }: { courseId: string; original: Original; local: boolean; hours: number; found: File | null }) {
  const t = useTranslations("localSource");
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ busy: boolean; ok?: string; error?: string }>({ busy: false });
  const send = async (file: File) => {
    setState({ busy: true });
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`/api/sources/originals?course=${encodeURIComponent(courseId)}&p=${encodeURIComponent(original.path)}`, { method: "POST", body: fd });
      const body = (await res.json().catch(() => ({}))) as { error?: string; home?: string };
      if (!res.ok) return setState({ busy: false, error: body.error ?? t("errorStatus", { status: res.status }) });
      setState({
        busy: false,
        ok: body.home === "cloud"
          ? t("sentCloud")
          : t("sentLocal", { hours }),
      });
    } catch {
      setState({ busy: false, error: t("sendInterrupted") });
    }
  };
  return (
    <Panel className="flex flex-col gap-3 p-6">
      <p className="font-medium text-ink-1">{t("sendTitle")}</p>
      <p className="text-[0.85rem] leading-relaxed text-ink-3">
        {local
          ? t("sendLocalHint")
          : t("sendCloudHint")}
      </p>
      <input ref={input} type="file" className="sr-only" aria-label={t("fileLabel", { name: original.name })} onChange={(e) => e.target.files?.[0] && send(e.target.files[0])} />
      <Button variant="secondary" loading={state.busy} onClick={() => (found ? send(found) : input.current?.click())} className="self-start">
        {!state.busy && <Upload className="size-4" strokeWidth={2.25} aria-hidden="true" />}
        {t("send", { name: original.name })}
      </Button>
      {state.ok && <p className="text-[0.82rem] text-emerald-hi" aria-live="polite">{state.ok}</p>}
      {state.error && <p className="text-[0.82rem] text-danger-hi" aria-live="polite">{state.error}</p>}
    </Panel>
  );
}
