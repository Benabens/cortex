// Banc synthétique : aucune donnée réelle, aucun appel sortant.
import { Suspense, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CourseProvider, useCourse, useJob } from '../../cortex/lib/ux/api';
import { configureJobWatch } from '../../cortex/lib/ux/job-watch';
import { DeleteAccount } from '../../cortex/app/compte/DeleteAccount';
import MockPage from '../../cortex/app/mock/[id]/page';
let failGrade = true;
let finishDelete: ((value: Response) => void) | null = null;
let resolveB: ((value: any) => void) | null = null;
let resolveLateA: ((value: any) => void) | null = null;
let lateA = false;
let posted = '';
const timers = new Map<number, () => void>(); let timerId=0;
const exam = {id:101, verifySummary:null, pdf:null, items:[{id:1,idx:0,topic:'Démo',type:'scq',stem:'Choisis A pour cette démo.',options:['A','B'],verified:1}],open:[{id:7,concept:'Démo synthétique',statement:'<p>Écris une réponse de démonstration.</p>',solution:'<p>Solution synthétique.</p>'}]};
window.fetch = async (url:any, options:any={}) => {
 const p=String(url);
 if(p==='/api/courses') return Response.json({courses:['A','B'].map(id=>({id,name:`Cours ${id}`,short:id,code:id,university:'Démo',teachers:[],language:'fr',examDate:null,durationMin:60,createdAt:''}))});
 if(p==='/api/account/delete') return new Promise(r=> { finishDelete=r; });
 if(p.includes('/grade')) { posted=options.body; if(failGrade) throw new Error('Réseau simulé'); return Response.json({score:1,total:1,detail:[{idx:0,correct:[0],chosen:[0],ok:true,explanation:'Réponse synthétique',misconceptions:[]}],openSolutions:exam.open}); }
 if(p.startsWith('/api/qcm/')) return Response.json(exam);
 throw new Error('Aucun accès réseau réel autorisé dans ce banc : '+p);
};
const job=(course:string)=>({id:1,type:'exam',status:'running',progress:10,currentStep:course,resultPath:null});
configureJobWatch({ fetchJob: async (_id,course)=> {
 if(course==='B') return new Promise(r=>{resolveB=r;});
 if(lateA) return new Promise(r=>{resolveLateA=r;});
 return job('A');
},setTimer:fn=>{ const id=++timerId; timers.set(id,fn);return id; },clearTimer:h=>{timers.delete(h as number);},isHidden:()=>false,onVisible:()=>()=>{}});
function Lens({enabled}:{enabled:boolean}) {
 const {courseId}=useCourse(); const value=useJob(enabled?1:null); const history=useRef<any[]>([]);
 useLayoutEffect(()=>{history.current.push([courseId,value?.currentStep??null]);},[courseId,value]);
 return <><output id="job">{`${courseId}:${value?.currentStep??'null'}`}</output><pre id="job-history">{JSON.stringify(history.current)}</pre></>;
}
function Harness(){
 const {courseId,setCourseId,ready}=useCourse(); const [enabled,setEnabled]=useState(true); const [tick,setTick]=useState(0); const [examId,setExamId]=useState('101'); const params=useMemo(()=>Promise.resolve({id:examId}),[examId]);
 return <main><h1>Pipeline Cortex — banc synthétique</h1><p>Aucun compte ni cours réel. Tous les appels sont remplacés en mémoire.</p>
 <button id="outside">Contrôle extérieur</button><hr/><h2>Jobs</h2>
 <button onClick={()=>setCourseId('A')}>Cours A</button><button onClick={()=>setCourseId('B')}>Cours B</button>
 <button onClick={()=>{lateA=true;const due=[...timers.values()];timers.clear();due.forEach(fn=>fn());}}>Préparer rappel tardif A</button>
 <button onClick={()=>{resolveLateA?.(job('A'));setTick(tick+1);}}>Livrer rappel tardif A</button>
 <button onClick={()=>{resolveB?.(job('B'));setTick(tick+1);}}>Livrer B</button>
 <button onClick={()=>setEnabled(v=>!v)}>Activer ou couper le job</button>
 {ready&&<Lens enabled={enabled}/>}<hr/><h2>Examen</h2>
 <button onClick={()=>{failGrade=false;setTick(tick+1);}}>Rétablir la correction</button>
 <button onClick={()=>setExamId(id=>id==='101'?'102':'101')}>Changer d’examen</button>
 <Suspense fallback={<p>Chargement démo…</p>}><MockPage key={examId} params={params}/></Suspense>
 <pre id="grade-payload">{posted}</pre><hr/><h2>Dialogue</h2><DeleteAccount/>
 <button onClick={()=>finishDelete?.(Response.json({error:'Erreur simulée sans suppression'},{status:503}))}>Terminer suppression simulée en erreur</button>
 <p id="tick">État de banc {tick}, cours {courseId}</p></main>;
}
createRoot(document.getElementById('root')!).render(<CourseProvider><Harness/></CourseProvider>);
