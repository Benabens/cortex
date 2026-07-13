import { q as db } from "@/db/q";
import { tokenize } from "@/lib/text";
import { useCourse } from "@/lib/req";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTENT_ROOT = path.resolve(process.cwd(), "..");

/** Script injecté côté client : déplie la bonne carte, scrolle, entoure, surligne. */
function injectedScript(targetTitle: string, terms: string[]): string {
  const payload = JSON.stringify({ targetTitle, terms });
  return `
<style>
  .cortex-hl { background: rgba(197,138,79,.28); color: inherit; border-radius: 3px; padding: 0 1px; }
  .cortex-focus { outline: 2px solid #c58a4f !important; outline-offset: 4px; border-radius: 6px;
    animation: cortexPulse 1.4s ease-out 2; }
  @keyframes cortexPulse { 0%{ box-shadow: 0 0 0 0 rgba(197,138,79,.5);} 100%{ box-shadow: 0 0 0 14px rgba(197,138,79,0);} }
  .cortex-banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 99999;
    background: #2a2927; color: #e8e6df; border: 1px solid #c58a4f; border-radius: 8px;
    padding: 7px 14px; font: 13px/1.3 -apple-system, system-ui, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.4); }
  .cortex-banner a { color: #6fa8d6; cursor: pointer; margin-left: 10px; }
</style>
<script>
(function(){
  var P = ${payload};
  function fold(s){ var o=''; for(var i=0;i<s.length;i++){ var c=s[i].normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').toLowerCase(); o+= c.length?c[0]:s[i].toLowerCase(); } return o; }
  var foldedTarget = fold(P.targetTitle).replace(/\\s+/g,' ').trim().slice(0,60);

  function findTarget(){
    if(!foldedTarget) return null;
    var els = document.body.getElementsByTagName('*');
    var best=null, bestLen=Infinity;
    for(var i=0;i<els.length;i++){
      var el=els[i];
      if(el.children.length>6) continue;
      var t = fold(el.textContent||'').replace(/\\s+/g,' ').trim();
      if(t.length && t.length<bestLen && t.indexOf(foldedTarget)!==-1){ best=el; bestLen=t.length; }
    }
    return best;
  }

  function openAncestors(el){
    var n=el;
    while(n && n!==document.body){
      if(n.tagName==='DETAILS') n.open=true;
      n=n.parentElement;
    }
  }

  // Sites SPA (reviews.html / index.html) : seule la section .chapter.active est visible.
  function activateSection(el){
    var sec = el.closest && el.closest('section.chapter');
    if(!sec) return;
    var actives = document.querySelectorAll('section.chapter.active');
    for(var i=0;i<actives.length;i++) actives[i].classList.remove('active');
    sec.classList.add('active');
    if(sec.id){
      var nav = document.querySelector('.sidebar-item[data-chapter="'+sec.id+'"]');
      if(nav){ var cur=document.querySelectorAll('.sidebar-item.active'); for(var j=0;j<cur.length;j++) cur[j].classList.remove('active'); nav.classList.add('active'); }
    }
  }

  // Surligne les termes dans un élément (accent-insensible, mapping 1:1).
  function highlight(root){
    if(!root || !P.terms.length) return 0;
    var count=0;
    var walker=document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode:function(node){
        var p=node.parentNode;
        if(!p) return NodeFilter.FILTER_REJECT;
        var tag=p.nodeName;
        if(tag==='SCRIPT'||tag==='STYLE'||p.classList&&p.classList.contains('cortex-hl')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes=[], n;
    while(n=walker.nextNode()) nodes.push(n);
    nodes.forEach(function(node){
      var text=node.nodeValue;
      var f=fold(text);
      var ranges=[];
      P.terms.forEach(function(term){
        if(term.length<2) return;
        var idx=0;
        while((idx=f.indexOf(term, idx))!==-1){ ranges.push([idx, idx+term.length]); idx+=term.length; }
      });
      if(!ranges.length) return;
      ranges.sort(function(a,b){return a[0]-b[0];});
      // fusion des chevauchements
      var merged=[ranges[0]];
      for(var i=1;i<ranges.length;i++){ var last=merged[merged.length-1];
        if(ranges[i][0]<=last[1]) last[1]=Math.max(last[1],ranges[i][1]); else merged.push(ranges[i]); }
      var frag=document.createDocumentFragment(), pos=0;
      merged.forEach(function(r){
        if(r[0]>pos) frag.appendChild(document.createTextNode(text.slice(pos,r[0])));
        var m=document.createElement('mark'); m.className='cortex-hl'; m.textContent=text.slice(r[0],r[1]);
        frag.appendChild(m); pos=r[1]; count++;
      });
      if(pos<text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
      node.parentNode.replaceChild(frag, node);
    });
    return count;
  }

  function run(){
    var target=findTarget();
    if(target){
      var card = target.closest('details');
      if(card){
        // carte flip : active la section + déplie + surligne + entoure la carte
        activateSection(card);
        openAncestors(card);
        highlight(card);
        card.classList.add('cortex-focus');
        setTimeout(function(){ card.scrollIntoView({behavior:'smooth', block:'center'}); }, 160);
      } else {
        // pas de carte (ex. exo) : surligne toute la page, entoure l'élément trouvé
        activateSection(target);
        openAncestors(target);
        highlight(document.body);
        target.classList.add('cortex-focus');
        setTimeout(function(){ target.scrollIntoView({behavior:'smooth', block:'center'}); }, 160);
      }
    } else {
      // pas trouvé précisément : surligne toute la page + scroll au 1er match
      highlight(document.body);
      var first=document.querySelector('.cortex-hl');
      if(first){ openAncestors(first); first.scrollIntoView({behavior:'smooth', block:'center'}); }
    }
    var b=document.createElement('div'); b.className='cortex-banner';
    b.innerHTML='⟵ Cortex · trouvé ici<a id="cortex-clear">enlever surlignage</a>';
    document.body.appendChild(b);
    b.querySelector('#cortex-clear').addEventListener('click', function(){
      document.querySelectorAll('.cortex-hl').forEach(function(m){ m.replaceWith(document.createTextNode(m.textContent)); });
      document.querySelectorAll('.cortex-focus').forEach(function(e){ e.classList.remove('cortex-focus'); });
      b.remove();
    });
    setTimeout(function(){ if(b.parentNode) b.style.opacity='0.35'; }, 6000);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
</script>`;
}

export async function GET(req: NextRequest) {
  useCourse(req);
  const sp = req.nextUrl.searchParams;
  const src = sp.get("src") ?? "";
  const q = sp.get("q") ?? "";
  const itemId = sp.get("item");

  // Sécurité : chemin sous CONTENT_ROOT, .html uniquement, pas de traversal.
  const abs = path.resolve(CONTENT_ROOT, src);
  if (!abs.startsWith(CONTENT_ROOT + path.sep) || !abs.endsWith(".html") || !fs.existsSync(abs)) {
    return new NextResponse("Fichier introuvable", { status: 404 });
  }

  let title = "";
  if (itemId) {
    const row = await db.get<{ title: string | null }>("SELECT title FROM items WHERE id = ?", Number(itemId));
    title = row?.title ?? "";
  }
  const terms = tokenize(q, 2);

  let html = fs.readFileSync(abs, "utf8");

  // <base> pour que les ressources relatives (images, css) se résolvent bien.
  const dir = path.dirname(src).replace(/^\.$/, "");
  const baseHref = "/sites/" + (dir ? dir + "/" : "");
  const baseTag = `<base href="${baseHref}">`;
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + baseTag);
  else html = baseTag + html;

  const inj = injectedScript(title, terms);
  if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, inj + "</body>");
  else html = html + inj;

  return new NextResponse(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
