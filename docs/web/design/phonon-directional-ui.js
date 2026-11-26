/* Opt-in symmetry-aware directional strains; isotropic results remain independent. */
(function(root){
'use strict';
const $=id=>document.getElementById(id),api=()=>root.CalculationProject;
const workerUrl='./phonon-worker.js?v=a17c702958db7f24';
let owner=null,reference=null,basis=null,project=null,results={},enabled=false,externalBusy=false,running=null,generation=0,inspection=null,derivativeWorker=null;
const clone=v=>JSON.parse(JSON.stringify(v));
function refreshOptions(){
 root.PhononGruneisenUi?.refreshVolumeOption?.();
 const select=$('phonon-band-color');
 for(const id of ['ab','a','b','c']){
  let option=[...select.options].find(o=>o.value==='gruneisen-'+id);
  const group=basis?.supported&&basis.groups.find(g=>g.id===id);
  if(!group){if(option)option.remove();continue;}
  if(!option){option=new Option(group.label,'gruneisen-'+id);select.add(option);}
  option.disabled=!results[id];
 }
}
function steps(){return Object.fromEntries((basis?.groups||[]).map(g=>[g.id,$('directional-step-'+g.id).valueAsNumber]));}
function render(stage){
 $('directional-enable-wrap').hidden=!basis?.supported;
 $('directional-enable').checked=enabled;
 $('directional-enable').disabled=!!running||externalBusy;
 $('directional-settings').hidden=!enabled||!basis?.supported;
 const valid=(basis?.groups||[]).every(g=>{const x=$('directional-step-'+g.id)?.valueAsNumber;return Number.isFinite(x)&&x>=.1&&x<=5;});
 $('directional-start').disabled=!owner||!reference||!basis?.supported||!enabled||!valid||!!running||externalBusy||!!owner.result.nac;
 $('directional-stop').disabled=!running;
 for(const input of $('directional-steps').querySelectorAll('input'))input.disabled=!!running||externalBusy;
 const body=$('directional-table').tBodies[0];body.replaceChildren();
 let complete=0,total=(basis?.groups.length||0)*2;
 for(const group of basis?.groups||[])for(const sign of [-1,1]){
  const h=$('directional-step-'+group.id)?.valueAsNumber,task=project?.tasks.find(t=>t.settings.analysis.group===group.id&&t.settings.analysis.sign===sign&&t.settings.analysis.stepPercent===h);
  const row=body.insertRow(),status=task?.status||'not calculated';if(status==='completed')complete++;
  const stability=task?.result?.qha?.thermal?.stability;
  const stateLabel=status+(stability?.status==='unstable'?` · ${stability.imaginaryCount} imaginary mesh modes (2×2×2)`:'');
  for(const text of [group.id+(sign<0?'−':'+'),Number.isFinite(h)?(sign*h).toFixed(2)+'%':'—',Number.isFinite(h)?(((1+sign*h/100)**group.multiplicity-1)*100).toFixed(3)+'%':'—',stateLabel])row.insertCell().textContent=text;
 }
 const validity=$('directional-validity');const record=Object.values(results)[0];
 const imaginary=record?record.result.samples.reduce((n,s)=>n+s.modes.filter(m=>m.mask==='imaginary').length,0):0;
 const unstableStates=project?.tasks.filter(t=>t.result?.qha?.thermal?.stability?.status==='unstable').length||0;
 validity.hidden=!imaginary&&!unstableStates;validity.textContent=(imaginary?`Reference dispersion has ${imaginary} imaginary path modes; their γ is undefined. `:'')+(unstableStates?`${unstableStates} strain states have imaginary modes on the 2×2×2 diagnostic mesh. `:'')+((imaginary||unstableStates)?'These results do not establish a dynamically stable phonon spectrum.':'');
 $('directional-start').textContent=running?'Calculating…':complete===total&&total?'View / resume results':`Calculate / resume · ${total-complete} to run`;
 if(stage)$('directional-status').textContent=`${complete}/${total} strain states complete · equilibrium FC reused · ${stage}`;
 refreshOptions();
}
function reset(){
 running?.abort();derivativeWorker?.terminate();derivativeWorker=null;reference=null;basis=null;project=null;results={};enabled=false;inspection=null;
 $('directional-steps').replaceChildren();$('directional-basis').textContent='Identifying the relaxed structure symmetry…';refreshOptions();render();
}
function setSource(next){
 if(next===owner)return;
 ++generation;reset();owner=next;
 if(!owner){$('directional-basis').textContent='Complete phonons to identify the relaxed structure axes.';return;}
 const token=generation,current=owner;
 inspection=root.PhononQha.inspectDirectional(current).then(plan=>{
  if(token!==generation||current!==owner)return;
  reference=plan;basis=plan.directionalBasis;
  if(!basis)basis={supported:false,groups:[],reason:'Axis classification unavailable. Using isotropic γ(V).'};
  const inputGroup=current.relaxSymmetry?.spaceGroupNumber||current.relaxSymmetry?.spaceGroup||current.relaxSymmetry?.number;
  $('directional-basis').textContent=`${basis.symbol||'Space group'} ${basis.spaceGroup??'unknown'} · ${basis.system||'unknown'} · tolerance ${current.settings.symprec} Å${inputGroup&&inputGroup!==basis.spaceGroup?' · input group '+inputGroup+' → relaxed '+basis.spaceGroup:''} · ${basis.reason}${basis.supported?' Conventional '+basis.conventionalAtoms+' / primitive '+basis.primitiveAtoms+' atoms.':''}`;
  for(const group of basis.groups){
   const label=document.createElement('label');label.textContent=group.id+' length strain ± (%) ';
   const input=document.createElement('input');Object.assign(input,{id:'directional-step-'+group.id,type:'number',min:'.1',max:'5',step:'.1',value:'1'});input.setAttribute('aria-label',group.id+' length strain percent');
   input.oninput=()=>{delete results[group.id];root.PhononGruneisenUi.invalidateDirectional(group.id);render('Settings changed; other completed strain states remain reusable.');};label.append(input);$('directional-steps').append(label);
  }
  render(owner.result.nac?'Select the no-NAC dispersion before directional calculations.':null);
 }).catch(error=>{if(token!==generation)return;basis={supported:false,groups:[],reason:error.message};$('directional-basis').textContent='Isotropic γ(V) · axis verification failed: '+error.message;render();});
}
async function derivative(group,stepPercent,signal){
 const centerHash=await api().hash(owner.forceConstants),current=owner;
 const instance=new Worker(workerUrl);derivativeWorker=instance;
 return await new Promise((resolve,reject)=>{
  const id=crypto.randomUUID();
  const finish=(fn,value)=>{signal.removeEventListener('abort',cancel);instance.terminate();if(derivativeWorker===instance)derivativeWorker=null;fn(value);};
  const cancel=()=>finish(reject,new DOMException('Stopped','AbortError'));signal.addEventListener('abort',cancel,{once:true});
  instance.onerror=e=>finish(reject,Error(e.message));instance.onmessage=async({data:m})=>{
   if(m.jobId!==id||owner!==current)return;
   if(m.type==='error')finish(reject,Error(m.message));
   if(m.type==='gruneisen-result'){
    try{
     const value={...m.result,configurationHash:current.configurationHash,segments:current.result.segments,samples:m.result.samples.map((s,i)=>({...s,distance:current.result.qpoints[i].distance,label:current.result.qpoints[i].label}))};
     finish(resolve,{result:value,sha256:await api().hash(value)});
    }catch(error){finish(reject,error);}
   }
  };
  instance.postMessage({type:'directional-gruneisen',jobId:id,inputRevision:current.revision,structure:current.preparedInput,settings:{...current.settings,nacEnabled:false},project,centerForceConstants:current.forceConstants,centerHash,qpoints:current.result.qpoints.map(p=>p.q),group,stepPercent});
 });
}
function activate(id){
 const record=results[id];if(!record)return;
 root.PhononGruneisenUi.displayDirectional(record.result,record.sha256);render();
}
async function start(){
 if(running||!owner||!reference)return;
 const compact=navigator.maxTouchPoints>0&&Math.min(screen.width,screen.height)<=1024,budget=(compact?96:384)*1048576;
 const estimated=root.PhononDirectional.estimatedModeBytes(reference.primitive.atoms.length,owner.result.qpoints.length,basis.groups.length);
 if(estimated>budget||owner.result.qpoints.length*reference.primitive.atoms.length**2>200000){render(`Estimated mode storage ${Math.ceil(estimated/1048576)} MiB exceeds this view's budget; reduce path density or the primitive cell. No forces started.`);return;}
 const current=owner,controller=new AbortController();running=controller;render('Preparing immutable strain tasks');
 try{
  project=await root.PhononQha.runDirectional(current,reference,steps(),project,controller,(value,stage)=>{if(owner!==current)return;project=value;render(stage);});
  controller.signal.throwIfAborted();
  for(const group of basis.groups){
   const h=steps()[group.id],tasks=project.tasks.filter(t=>t.settings.analysis.group===group.id);
   if(!tasks.every(t=>t.status==='completed'))continue;
   if(!results[group.id])results[group.id]=await derivative(group.id,h,controller.signal);
  }
  const failure=project.tasks.find(t=>t.attemptSummary?.error)?.attemptSummary.error;
  render(project.state+(failure?' · '+failure:''));
  const id=basis.groups.find(g=>results[g.id])?.id;if(id)activate(id);
 }catch(error){if(owner===current)render(error.name==='AbortError'?'Stopped. Completed strain states are saved.':error.message);}
 finally{if(running===controller)running=null;render();}
}
$('directional-enable').onchange=()=>{enabled=$('directional-enable').checked;render('Ready');};
$('directional-start').onclick=start;
$('directional-stop').onclick=()=>running?.abort();
document.addEventListener('macer-gruneisen-color',({detail})=>{if(detail.key.startsWith('gruneisen-'))activate(detail.key.slice(10));});
function projectFields(current){
 if(current!==owner||!project)return {};
 const payload={schema:'macer-directional-gruneisen-workflow-v1',configurationHash:current.configurationHash,project:clone(project),results:clone(results),steps:steps(),enabled,selection:root.PhononGruneisenUi.getSelection(),active:$('phonon-band-color').value};
 return {directionalGruneisen:payload};
}
async function validateSaved(p){
 const saved=p.directionalGruneisen;if(!saved)return null;
 if(saved.schema!=='macer-directional-gruneisen-workflow-v1'||saved.configurationHash!==p.configurationHash||!p.completed||!p.forceConstants?.values)throw Error('Directional analysis does not match the saved phonons.');
 await api().verifyTaskIdentities(saved.project);
 if(saved.project.model.modelKey!==p.modelKey||saved.project.model.weightsSha256!==p.model.weights_sha256)throw Error('Directional model identity differs.');
 const centerHash=await api().hash(p.forceConstants);
 for(const [id,record] of Object.entries(saved.results)){
  const r=record.result,tasks=[-1,1].map(sign=>saved.project.tasks.find(t=>t.settings.analysis.group===id&&t.settings.analysis.sign===sign));
  if(record.sha256!==await api().hash(r)||r.analysis?.id!==id||r.configurationHash!==p.configurationHash||r.analysis.stepPercent!==saved.steps[id]||tasks.some(t=>t?.status!=='completed')||JSON.stringify(r.sourceHashes)!==JSON.stringify([tasks[0].result.qhaSha256,centerHash,tasks[1].result.qhaSha256])||JSON.stringify(r.samples.map(s=>s.q))!==JSON.stringify(p.result.qpoints.map(q=>q.q))||r.samples.some(s=>s.modes.length!==p.result.atoms.length*3))throw Error('Saved directional result or its force-constant binding is invalid.');
 }
 if(!Number.isInteger(saved.selection?.qIndex)||!Number.isInteger(saved.selection?.modeIndex)||!p.result.qpoints[saved.selection.qIndex]?.bands[saved.selection.modeIndex])throw Error('Invalid saved directional selection.');
 return saved;
}
async function restore(current,saved){
 setSource(current);await inspection;
 if(owner!==current||!basis?.supported)throw Error('Saved directional axes could not be verified.');
 const expected=clone(basis);
 for(const record of Object.values(saved.results))if(JSON.stringify(record.result.analysis.basis)!==JSON.stringify(expected))throw Error('Saved directional axes differ from the current symmetry.');
 project=saved.project;results=saved.results;enabled=saved.enabled;
 for(const g of basis.groups)if(saved.steps[g.id])$('directional-step-'+g.id).value=saved.steps[g.id];
 render('Saved directional analysis reopened · no forces or derivatives recalculated');
 const id=saved.active?.startsWith('gruneisen-')?saved.active.slice(10):null;
 if(id&&results[id]){root.PhononBand.select(saved.selection.qIndex,saved.selection.modeIndex);activate(id);}
}
root.PhononDirectionalUi={meshContext:()=>({owner,reference,basis,project,results,running:!!running,steps:steps()}),setSource,refreshOptions,setBusy:value=>{externalBusy=value;render();},projectFields,validateSaved,restore};
})(globalThis);
