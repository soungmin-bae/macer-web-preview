(function(root){
'use strict';const S=root.StructureSearch,$=id=>document.getElementById(id);
function mount(kind,anchor,host){
 const box=document.createElement('details');box.className='structure-search';box.id=kind+'-search';box.open=true;
 box.innerHTML='<summary>Search Alexandria</summary><form><label>Search <input required maxlength="100" placeholder="SrTiO3" aria-label="'+kind+' structure search"></label><label>Match <select></select></label><button type="submit">Search</button><button type="button" data-cancel hidden>Cancel preview</button></form><p role="status" aria-live="polite">Enter a query to search Alexandria PBE.</p><div class="search-results" role="list" aria-label="Search results"></div><button type="button" data-next hidden>Next page</button><div class="search-selection" hidden><p></p><button type="button" data-use>Use structure</button></div>';
 anchor.before(box);const credit=document.createElement('p');credit.className='search-credit';credit.innerHTML='<a href="https://alexandria.icams.rub.de/about.html" target="_blank" rel="noopener noreferrer">Alexandria</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>';box.append(credit);const form=box.querySelector('form'),query=form.querySelector('input'),mode=form.querySelector('select'),status=box.querySelector('[role=status]'),list=box.querySelector('[role=list]'),next=box.querySelector('[data-next]'),selection=box.querySelector('.search-selection'),use=box.querySelector('[data-use]');let chosen=null,cursor=null,lastQuery='',lastMode='';const requests=root.StructureSearchRequests.create(),resultSection=document.createElement('details'),resultSummary=document.createElement('summary');resultSection.hidden=true;resultSection.append(resultSummary);list.before(resultSection);resultSection.append(list);
 const guide=document.createElement('p');guide.id=kind+'-search-guide';guide.className='search-guide';guide.setAttribute('aria-live','polite');form.after(guide);query.setAttribute('aria-describedby',guide.id);
 for(const [value,entry] of Object.entries(S.matchModes))mode.add(new Option(entry.label,value));
 function updateSearchGuide(){if(!Object.hasOwn(S.matchModes,mode.value))mode.value='formula';const help=S.matchModes[mode.value];query.placeholder=help.placeholder;guide.textContent=help.text;}
 mode.addEventListener('change',updateSearchGuide);updateSearchGuide();
 const runButton=$(kind==='relax'?'run':'phonon-calculate'),modelSelect=$(kind==='relax'?'model-select':'phonon-model');
 const previewRun=document.createElement('button');previewRun.id=kind+'-preview-run';previewRun.type='button';previewRun.className=runButton.className;previewRun.style.whiteSpace='normal';previewRun.hidden=true;runButton.after(previewRun);
 let loadingDetail=false;
 function syncPreviewRun(){
  const active=loadingDetail||!!chosen;runButton.hidden=active;previewRun.hidden=!active;
  box.querySelector('[data-cancel]').hidden=!active;next.hidden=active||cursor===null;
  previewRun.textContent=loadingDetail?'Loading selected structure…':'Use preview & '+runButton.textContent.replace(/^[▶\s]+/,'');
  previewRun.disabled=loadingDetail||!chosen||!!host()?.busy()||!!modelSelect?.disabled;
 }
 function applySelection(){
  if(!chosen)return false;
  if(host()?.busy())throw Error('Stop the calculation before replacing the input.');
  const detail=chosen;
  if(host().useStructure(detail.structure,detail.provenance)===false)throw Error('Structure validation failed. The calculation has not started.');
  chosen=null;loadingDetail=false;selection.hidden=true;syncPreviewRun();status.textContent=`Structure applied: ${detail.displayFormula}. Calculation has not started.`;return true;
 }
 previewRun.onclick=()=>{
  try{if(!applySelection())return;if(runButton.disabled){status.textContent='Structure applied. Check the model and calculation settings before running.';return;}runButton.click();}
  catch(error){status.textContent=error.message;}
 };
 new MutationObserver(syncPreviewRun).observe(runButton,{attributes:true,attributeFilter:['disabled'],childList:true,subtree:true});
 if(modelSelect)new MutationObserver(syncPreviewRun).observe(modelSelect,{attributes:true,attributeFilter:['disabled'],childList:true,subtree:true});
 function preview(structure,provenance=null){host()?.previewStructure(structure);root.StructureInfo?.show(kind,structure||host()?.inputStructure(),{preview:!!structure,provenance:provenance||structure?.provenance});}
 const groupLabel=n=>root.StructureInfoCore?.spaceGroup(n)||('No. '+(n??'unknown'));
 function cancel(){requests.invalidate();chosen=null;loadingDetail=false;selection.hidden=true;syncPreviewRun();for(const b of list.querySelectorAll('button'))b.setAttribute('aria-pressed','false');preview(null);}
 function begin(){return requests.begin();}
 async function run(more=false){const h=host();if(h?.busy()){status.textContent='Stop the calculation before searching.';return;}const req=begin();chosen=null;loadingDetail=false;selection.hidden=true;syncPreviewRun();preview(null);list.replaceChildren();resultSection.hidden=true;next.hidden=true;status.textContent='Searching…';
 try{if(!more){lastQuery=query.value;lastMode=mode.value;cursor=null;}const page=await S.search(lastQuery,lastMode,cursor,req.signal);if(!requests.isCurrent(req.id))return;cursor=page.next;next.hidden=cursor===null;resultSection.hidden=!page.items.length;resultSection.open=true;resultSummary.textContent=`Results (${page.items.length})`;status.textContent=page.items.length?`${page.items.length} results · Alexandria PBE · Above hull: low to high`:'No structures found.';
 try{const recent=JSON.parse(localStorage.getItem('macer-structure-recent')||'[]').filter(x=>x.query!==lastQuery||x.mode!==lastMode);localStorage.setItem('macer-structure-recent',JSON.stringify([{query:lastQuery,mode:lastMode},...recent].slice(0,20)));}catch{}
 for(const item of page.items){const button=document.createElement('button');button.type='button';button.className='search-result';button.dataset.structureId=item.id;button.textContent=S.resultLabel(item);button.onclick=()=>choose(item,button);button.onkeydown=e=>{const buttons=[...list.querySelectorAll('button')],i=buttons.indexOf(button);if(e.key==='Home'||e.key==='End'){e.preventDefault();buttons[e.key==='Home'?0:buttons.length-1]?.focus();}else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();buttons[Math.max(0,Math.min(buttons.length-1,i+(e.key==='ArrowDown'?1:-1)))].focus();}};list.append(button);}
 }catch(e){if(requests.isCurrent(req.id))status.textContent=S.errorMessage(e);}}
 async function choose(item,button){if(host()?.busy()){status.textContent='Stop the calculation before previewing.';return;}const req=begin();chosen=null;loadingDetail=true;selection.hidden=true;syncPreviewRun();preview(null);status.textContent='Loading selected structure…';try{const detail=await S.getStructure(item.id,req.signal);if(!requests.isCurrent(req.id))return;preview(detail.structure,detail.provenance);const displayFormula=S.displayFormula(item.chemical_formula_reduced);chosen={...detail,displayFormula};loadingDetail=false;syncPreviewRun();for(const b of list.querySelectorAll('button'))b.setAttribute('aria-pressed',String(b===button));selection.querySelector('p').textContent=`Preview: ${displayFormula} · ${detail.structure.comment} · ${detail.structure.atoms.length} atoms · DB space group ${groupLabel(detail.provenance.databaseSpaceGroup)}. Current input is unchanged.`;selection.hidden=false;resultSection.open=false;use.focus({preventScroll:true});status.textContent='Review the preview below. Apply it to edit or calculate.';}catch(e){if(requests.isCurrent(req.id)){loadingDetail=false;syncPreviewRun();status.textContent=S.errorMessage(e);}}}
 form.addEventListener('input',()=>{try{cancel();list.replaceChildren();resultSection.hidden=true;next.hidden=true;cursor=null;status.textContent='Press Search to find structures.';}catch(e){status.textContent=e.message;}});
 form.onsubmit=e=>{e.preventDefault();run();};next.onclick=()=>run(true);box.querySelector('[data-cancel]').onclick=()=>{try{cancel();status.textContent='Preview closed. Current input retained.';}catch(e){status.textContent=e.message;}};
 use.classList.add('primary');use.onclick=()=>{try{applySelection();}catch(e){status.textContent=e.message;}};
 document.addEventListener('macer-structure-applied',e=>{if(e.detail?.kind===kind){chosen=null;loadingDetail=false;selection.hidden=true;syncPreviewRun();requests.invalidate();}});
 document.addEventListener('input',e=>{if(e.target.id===(kind==='relax'?'structure':'phonon-structure')){chosen=null;loadingDetail=false;selection.hidden=true;syncPreviewRun();requests.invalidate();try{preview(null);}catch{}}});
}
mount('relax',$('structure').closest('.structure-grid'),()=>root.MacerRelax);
mount('phonon',$('phonon-structure').closest('.phonon-input-columns'),()=>root.PhononJob);
$('phonon-input-undo').onclick=()=>root.PhononJob.restoreInput(-1);$('phonon-input-redo').onclick=()=>root.PhononJob.restoreInput(1);
})(globalThis);
