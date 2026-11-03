"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowRight, BookOpen, Check, Plus } from "lucide-react";
import { TrainingNav } from "@/components/entrainement/TrainingNav";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/primitives";
import { Button } from "@/components/ui/Button";
import { LoadError } from "@/components/ui/LoadError";
import { apiPost, asText, useApi, type ApiError } from "@/lib/ux/api";
import { trainHref } from "@/lib/ux/next-up";
import type { ProgramResp } from "@/lib/ux/program";
import { toStatus, type Dash } from "@/lib/ux/types";

export default function SessionPage() {
  return <Suspense fallback={<div className="skeleton h-48 rounded-xl" />}><Session /></Suspense>;
}
function Session() {
  const selected = Number(useSearchParams().get("notion"));
  const program = useApi<ProgramResp>("/api/program");
  const dashboard = useApi<Dash>("/api/dashboard");
  return <div className="flex flex-col gap-6">
    <PageHeader title="S’entraîner" description="Une séance à ton rythme, à partir des notions de ton cours." />
    <TrainingNav current="/seance" />
    {program.loading || dashboard.loading ? <div className="skeleton h-80 rounded-xl" aria-label="Chargement de la séance" /> :
      program.error || dashboard.error || !program.data || !dashboard.data ? <LoadError title="Impossible de charger la séance" onRetry={() => { program.refetch(); dashboard.refetch(); }} /> :
      <SessionComposer key={`${dashboard.data.course.id}-${selected}`} data={dashboard.data} program={program.data} addedId={selected} />}
  </div>;
}

function SessionComposer({ data, program, addedId }: { data: Dash; program: ProgramResp; addedId: number }) {
  const available = program.topics.filter(t => asText(t.label));
  const storageKey = `cortex-session:${data.course.id}`;
  const [ids, setIds] = useState<number[]>(() => {
    const defaults = [data.next, ...data.upNext].flatMap(t => t ? [t.id] : []).slice(0, 3);
    let stored = defaults;
    try {
      const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (Array.isArray(value)) stored = value.filter((id): id is number => typeof id === "number");
    } catch {}
    const next = [...new Set([...stored, ...(addedId > 0 ? [addedId] : [])])].filter(id => available.some(t => t.id === id));
    return next;
  });
  useEffect(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(ids)); } catch {}
  }, [storageKey, ids]);
  const [active, setActive] = useState<number | null>(null);
  const [scores, setScores] = useState<Record<number, number>>({});
  const [score, setScore] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const selected = ids.flatMap(id => available.find(t => t.id === id) ?? []);
  const current = available.find(t => t.id === active);
  const toggle = (id: number) => {
    const next = ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id];
    setIds(next);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
  };
  const start = () => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(ids)); } catch {}
    setActive(ids.find(id => scores[id] === undefined) ?? ids[0] ?? null);
  };
  async function save() {
    if (!current) return;
    setBusy(true); setError(null);
    try {
      await apiPost("/api/program/score", data.course.id, { topicId: current.id, score });
      setScores(previous => ({ ...previous, [current.id]: score }));
      setActive(null);
    } catch (e) { setError((e as ApiError).message || "Impossible d’enregistrer ton résultat."); }
    finally { setBusy(false); }
  }
  return <>
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(16rem,1fr)]">
      <Panel className="p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm text-violet-hi">Ta séance</p><h2 className="mt-1 text-2xl font-semibold">{selected.length} notions sélectionnées</h2></div><span className="rounded-full bg-surface-2 px-3 py-1 text-xs text-ink-2">À ton rythme</span></div>
        <p className="mt-2 text-sm text-ink-3">Choisis tes notions, travaille leurs exercices des finals, puis évalue ta maîtrise.</p>
        {available.length ? <>
          <ul className="mt-5 divide-y divide-line">{(showAll ? available : available.filter(t => ids.includes(t.id) || [data.next, ...data.upNext].some(n => n?.id === t.id))).map(topic => <li key={topic.id}>
            <label className="flex min-h-16 cursor-pointer items-center gap-3 py-3"><input type="checkbox" className="size-5 shrink-0 accent-violet" checked={ids.includes(topic.id)} onChange={() => toggle(topic.id)} /><span className="min-w-0 flex-1"><span className="block break-words font-medium">{asText(topic.label)}</span><span className="mt-1 block text-xs text-ink-3">{topic.examCount > 0 ? `${topic.examCount} occurrences aux finals` : "Au programme"} · {toStatus(topic.status, topic.mastery) === "SOLIDE" ? "Solide" : topic.attempts > 0 ? "En cours" : "Jamais travaillée"}</span></span>{scores[topic.id] !== undefined && <Check className="size-4 text-violet-hi" aria-label="Évaluée pendant cette séance" />}</label>
          </li>)}</ul>
          <button type="button" className="mt-2 flex min-h-11 items-center gap-2 text-sm text-violet-hi" onClick={() => setShowAll(!showAll)}><Plus className="size-4" />{showAll ? "Réduire la liste" : "Choisir d’autres notions du programme"}</button>
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-5"><Button disabled={!ids.length} onClick={start}>Commencer la séance <ArrowRight className="size-4" /></Button><p className="text-xs text-ink-3">Sélection conservée pour ce cours dans cet onglet.</p></div>
        </> : <div className="mt-6"><p className="mb-4 text-sm text-ink-2">Ajoute tes sources et analyse le programme pour préparer ta première séance.</p><Button href="/sources">Ajouter des sources</Button></div>}
      </Panel>
      <div className="grid gap-4">
        <Panel className="p-5"><p className="text-sm text-violet-hi">Ne pas oublier</p><h2 className="mt-1 text-xl font-semibold">{data.schedule.due} révisions dues</h2><p className="mt-2 text-sm text-ink-3">Retrouve les questions déjà travaillées dans ta banque de révision.</p><Button href="/revision" variant="secondary" className="mt-4">Réviser</Button></Panel>
        <Panel className="p-5"><h2 className="text-xl font-semibold">Tes points à renforcer</h2>{data.weaknesses.top.length ? <ul className="mt-3 space-y-3">{data.weaknesses.top.map(w => <li key={w.id} className="text-sm"><p>{asText(w.topic) ?? "Faiblesse repérée"}</p><Link href={trainHref(asText(w.topic) ?? "")} className="inline-flex min-h-11 items-center text-violet-hi">Créer un exercice ciblé →</Link></li>)}</ul> : <p className="mt-2 text-sm text-ink-3">Aucune faiblesse repérée. Tu peux ajouter une erreur à retravailler depuis Progrès.</p>}<Link href="/faiblesses#faiblesses" className="mt-3 inline-flex min-h-11 items-center text-sm text-violet-hi">Voir mes faiblesses →</Link></Panel>
      </div>
    </div>
    {current && <Panel className="p-5 sm:p-7" aria-live="polite"><p className="text-sm text-violet-hi">Dans ta séance · notion {ids.indexOf(current.id) + 1} sur {ids.length}</p><h2 className="mt-2 text-2xl font-semibold">{asText(current.label)}</h2>{asText(current.method) && <p className="mt-2 text-sm text-ink-2">{asText(current.method)}</p>}
      <div className="mt-5 space-y-3">{current.occurrences_all?.length ? current.occurrences_all.map((o, i) => <details key={`${o.examId}-${i}`} className="rounded-xl border border-line p-4"><summary className="cursor-pointer text-sm font-medium">{o.examYear ? `Final ${o.examYear}` : asText(o.examTitle) ?? "Final"}{o.examPage ? ` · page ${o.examPage}` : ""}{o.points != null ? ` · ${o.points} points` : ""}</summary><p className="mt-3 whitespace-pre-wrap text-sm text-ink-2">{asText(o.statement) ?? "Ouvre le final pour lire l’énoncé complet."}</p>{o.examHref && <a className="mt-3 inline-flex min-h-11 items-center text-sm text-violet-hi" href={o.examHref} target="_blank" rel="noreferrer">Ouvrir l’exercice dans le final ↗</a>}</details>) : <p className="text-sm text-ink-3">Aucun énoncé de final rattaché à cette notion.</p>}</div>
      <div className="mt-4 flex flex-wrap gap-3"><Button href={trainHref(asText(current.label)!)} variant="secondary">Créer un nouvel exercice</Button>{current.courseHref && <a href={current.courseHref} className="inline-flex min-h-11 items-center gap-2 text-sm text-violet-hi" target="_blank" rel="noreferrer"><BookOpen className="size-4" />Passage de cours</a>}</div>
      <div className="mt-6 border-t border-line pt-5"><h3 className="font-semibold">Après avoir travaillé la notion</h3><p className="mt-1 text-sm text-ink-3">Ton auto-évaluation met à jour la maîtrise et la prochaine révision. Ce n’est pas une correction automatique.</p><label className="mt-4 flex flex-wrap items-center gap-3 text-sm">Ma maîtrise sur 10 <select className="min-h-11 rounded-lg border border-line bg-surface-2 px-3" value={score} onChange={e => setScore(Number(e.target.value))}>{Array.from({length: 11}, (_, i) => <option key={i} value={i}>{i} / 10</option>)}</select></label>{error && <p role="alert" className="mt-3 text-sm text-danger-hi">{error}</p>}<Button className="mt-4" disabled={busy} onClick={save}>{busy ? "Enregistrement…" : "Enregistrer et revenir à la séance"}</Button></div>
    </Panel>}
    <Panel className="p-5 sm:p-6"><h2 className="text-xl font-semibold">Le bilan de ta séance</h2>{Object.keys(scores).length ? <><p className="mt-2 text-sm text-ink-2">{Object.keys(scores).length} notion(s) évaluée(s). Les résultats sont enregistrés dans ton programme.</p><ul className="mt-3 space-y-2">{Object.entries(scores).map(([id, result]) => <li key={id} className="flex justify-between gap-3 text-sm"><span>{asText(available.find(t => t.id === Number(id))?.label)}</span><span>{result}/10</span></li>)}</ul><Link href="/programme" className="mt-4 inline-flex min-h-11 items-center text-sm text-violet-hi">Voir ce qui a changé sur la carte →</Link></> : <p className="mt-2 text-sm text-ink-3">Tes auto-évaluations apparaîtront ici pendant la séance. Aucun résultat tant que tu n’as pas évalué une notion.</p>}</Panel>
  </>;
}
