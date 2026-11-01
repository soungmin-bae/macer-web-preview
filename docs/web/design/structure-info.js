/* Read-only input/preview information, separate from optimizer symmetry. */
(function(root){
'use strict';const C=root.StructureInfoCore,$=id=>document.getElementById(id),states=new Map(),cache=new Map();
function invalid(kind){return kind==='relax'?$('structure').getAttribute('aria-invalid')==='true'||$('input-status').classList.contains('pending'):!root.PhononJob?.inputStructure();}
function host(kind){return kind==='relax'?root.MacerRelax:root.PhononJob;}
function textNode(tag,text){const node=document.createElement(tag);node.textContent=text;return node;}
function sourceLine(card,p){
 if(!p||p.provider!=='Alexandria')return;
 const row=textNode('p',`Source: Alexandria PBE · ${p.id}${p.modified?' · modified':''} · Source DB space group: ${C.spaceGroup(p.databaseSpaceGroup)}`);
 try{const url=new URL(p.url);if(url.origin==='https://alexandria.icams.rub.de'){const a=textNode('a','Source record');a.href=url.href;a.target='_blank';a.rel='noopener noreferrer';row.append(' · ',a);}}catch{}
 card.append(row);
}
function show(kind,s,options={}){
 const state=states.get(kind);if(!state)return;
 clearTimeout(state.timer);clearTimeout(state.timeout);state.id++;state.worker?.terminate();state.worker=null;
 const id=state.id,card=state.card;state.deferred=null;card.replaceChildren();
 const draft=!options.preview&&invalid(kind);
 card.append(textNode('h3',options.preview?'Search preview':draft?'Last valid structure · input draft incomplete':'Structure information'));
 if(!s){card.append(textNode('p','Enter a valid structure to see its information.'));return;}
 const g=C.geometry(s);card.append(textNode('p',`${g.reduced} · ${g.atoms} atoms${g.reduced!==g.formula?' · Cell '+g.formula:''} · ${g.periodic?'Periodic':'Nonperiodic'}`));
 if(g.lengths)card.append(textNode('p',`a / b / c: ${g.lengths.map(x=>x.toFixed(4)).join(' / ')} Å · α / β / γ: ${g.angles.map(x=>x.toFixed(2)).join(' / ')}° · Volume: ${g.volume.toFixed(3)} Å³`));
 sourceLine(card,options.provenance||s.provenance);
 const line=textNode('p',g.periodic?'Analyzing local space group…':'Space group: not applicable to a nonperiodic structure.');line.className='structure-local-symmetry';card.append(line);
 if(!g.periodic)return;
 const key=JSON.stringify([s.cell,s.atoms.map(a=>[a.element,a.position]),1e-4]);
 const render=result=>{line.textContent=`Local space group: ${C.spaceGroup(result.number,result.symbol)} · ${result.crystalSystem} · point group ${result.pointGroup} · primitive ${result.primitiveAtoms} atoms · symprec 0.0001 Å`;};
 if(cache.has(key)){render(cache.get(key));return;}
 if(draft){line.textContent='Local symmetry is not current while the input draft is incomplete.';return;}
 if($(kind==='relax'?'relax-workspace':'phonon-workspace').hidden){state.deferred={s,options};line.textContent='Open this tab to analyze local symmetry.';return;}
 state.timer=setTimeout(()=>{
  if(state.id!==id)return;
  try{
   const worker=new Worker('./structure-info-worker.js?v=2876c3a435385e5b');state.worker=worker;let settled=false;
   const fail=message=>{if(state.id!==id||settled)return;settled=true;clearTimeout(state.timeout);worker.terminate();state.worker=null;line.textContent='Local space group unavailable: '+message;const retry=textNode('button','Retry symmetry');retry.type='button';retry.onclick=()=>show(kind,s,options);card.append(retry);};
   worker.onmessage=({data:m})=>{if(settled||state.id!==id||m.id!==id||m.key!==key||m.consumer!==kind)return;clearTimeout(state.timeout);worker.terminate();state.worker=null;if(m.error){fail(m.error);return;}settled=true;cache.set(key,m.result);while(cache.size>10)cache.delete(cache.keys().next().value);render(m.result);};
   worker.onerror=()=>fail('analysis failed; calculation remains available.');
   state.timeout=setTimeout(()=>fail('analysis exceeded 15 seconds; calculation remains available.'),15000);
   worker.postMessage({id,consumer:kind,key,structure:s,tolerance:1e-4});
  }catch(error){line.textContent='Local space group unavailable: '+error.message;}
 },300);
}
function refresh(kind){show(kind,host(kind)?.inputStructure());}
for(const kind of ['relax','phonon']){
 const anchor=$(kind==='relax'?'structure':'phonon-structure').closest(kind==='relax'?'.structure-grid':'.phonon-input-columns');
 const card=document.createElement('section');card.id=kind+'-structure-info';card.className='structure-info';card.setAttribute('aria-label',kind==='relax'?'Structure information':'Phonon structure information');card.setAttribute('aria-live','polite');anchor.before(card);
 states.set(kind,{id:0,card});
 new MutationObserver(()=>refresh(kind)).observe($(kind==='relax'?'input-status':'phonon-input-state'),{childList:true,subtree:true});
 $(kind==='relax'?'relax-tab':'phonon-tab').addEventListener('click',()=>{const deferred=states.get(kind).deferred;if(deferred)show(kind,deferred.s,deferred.options);});
 refresh(kind);
}
document.addEventListener('macer-structure-applied',e=>{if(states.has(e.detail?.kind))refresh(e.detail.kind);});
root.StructureInfo=Object.freeze({show,refresh});
})(globalThis);
