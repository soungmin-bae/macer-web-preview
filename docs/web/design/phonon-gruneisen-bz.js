/* On-demand 1BZ Grüneisen postprocessing. No model/force requests. */
(function(root){'use strict';
const $=id=>document.getElementById(id),H=()=>root.CalculationProject;
const digest=r=>H().hash({samples:r.samples,metadata:r.metadata,key:r.key,metric:r.metric,label:r.label,mesh:r.mesh,total:r.total,configurationHash:r.configurationHash});
let owner=null,volumes=null,worker=null,modeWorker=null,bz=null,viewer=null,record=null,records=new Map(),selectedQ=0,selectedMode=0,vectors=null,view='band',busy=false,epoch=0,phase=0,playing=false,frame=0,last=0;
const compact=()=>innerWidth<701||navigator.maxTouchPoints>0;
const mesh=()=>['a','b','c'].map(a=>Number($('gamma-bz-mesh-'+a).value));
const status=text=>$('gamma-bz-status').textContent=text;
const color=(g,limit)=>{if(!Number.isFinite(g))return '#939ca7';const t=Math.min(1,Math.abs(g)/limit),end=g<0?[47,88,171]:[202,58,49];return '#'+end.map(v=>Math.round(250+(v-250)*t).toString(16).padStart(2,'0')).join('');};
function context(metric=$('gamma-bz-metric').value){
 if(!owner?.forceConstants||owner.result.nac)throw Error('Complete CPU / WASM phonons with NAC off.');
 if(metric==='volume'){
  const step=Number($('gruneisen-step').value),ratios=[1-step/100,1,1+step/100],tasks=ratios.map(r=>volumes?.tasks.find(t=>Math.abs(t.settings.volumeRatio-r)<1e-9&&t.status==='completed'));
  if(tasks.some(t=>!t))throw Error('Prepare the missing volume force constants in Grüneisen settings below.');
  return {project:volumes,tasks,stepPercent:step,hashes:tasks.map(t=>t.result.qhaSha256),label:'γ(V)'};
 }
 const d=root.PhononDirectionalUi?.meshContext(),group=d?.basis?.supported&&d.basis.groups.find(g=>g.id===metric),h=d?.steps[metric];
 const tasks=[-1,1].map(sign=>d?.project?.tasks.find(t=>t.settings.analysis.group===metric&&t.settings.analysis.sign===sign&&t.settings.analysis.stepPercent===h&&t.status==='completed'));
 if(d?.owner!==owner||!group||tasks.some(t=>!t))throw Error('Prepare both '+metric+' strain states in Grüneisen settings below.');
 if(d.running)throw Error('Wait for the directional strain calculation to finish.');
 return {project:d.project,tasks,group:metric,stepPercent:h,hashes:tasks.map(t=>t.result.qhaSha256),label:group.label};
}
async function binding(c,m){return JSON.stringify([owner.configurationHash,await H().hash(owner.forceConstants),c.group||'volume',c.stepPercent,c.hashes,m]);}
function controls(){
 $('gamma-bz-open').hidden=!owner;
 for(const id of ['gamma-bz-start','gamma-bz-metric','gamma-bz-mesh-a','gamma-bz-mesh-b','gamma-bz-mesh-c'])$(id).disabled=!owner||!!worker||busy;
 $('gamma-bz-stop').disabled=!worker;
 $('gamma-bz-start').textContent=record&&record.samples.length<record.total?'Resume γ in 1BZ':'Plot γ in 1BZ';
 $('gamma-bz-export').disabled=!record;
}
function options(){
 const select=$('gamma-bz-metric'),prior=select.value;select.replaceChildren(new Option('γ(V)','volume'));
 const d=root.PhononDirectionalUi?.meshContext();if(d?.owner===owner&&d.basis?.supported)for(const g of d.basis.groups)select.add(new Option(g.label,g.id));
 if([...select.options].some(o=>o.value===prior))select.value=prior;
 controls();
}
function cancel(){++epoch;worker?.terminate();worker=null;modeWorker?.terminate();modeWorker=null;controls();}
function setSource(next,p){
 if(owner!==next){cancel();owner=next;record=null;records.clear();vectors=null;selectedQ=selectedMode=0;playing=false;cancelAnimationFrame(frame);$('gamma-bz-content').hidden=true;status('Choose Plot γ in 1BZ. Saved force constants are reused; no new force evaluations.');}
 if(volumes?.projectId!==p?.projectId){for(const [key,r] of records)if(r.metric==='volume')records.delete(key);if(record?.metric==='volume'){cancel();record=null;vectors=null;$('gamma-bz-content').hidden=true;}}
 volumes=p;options();
}
function switchView(next){
 view=next;const panel=$('phonon-result');
 panel.querySelector('.phonon-visual-grid').hidden=next==='mesh';panel.querySelector('.phonon-analysis-grid').hidden=next==='mesh';
 $('gamma-bz-panel').hidden=next!=='mesh';$('gamma-bz-open').setAttribute('aria-pressed',String(next==='mesh'));$('gamma-bz-band').setAttribute('aria-pressed',String(next==='band'));
 if(next==='mesh'){options();requestAnimationFrame(()=>{if(record)draw();});}else{playing=false;$('gamma-bz-play').textContent='Play vibration';cancelAnimationFrame(frame);root.PhononBand.refresh();}
}
function filterModes(s){const lo=Number($('gamma-bz-frequency-min').value),hi=$('gamma-bz-frequency-max').value===''?Infinity:Number($('gamma-bz-frequency-max').value);return s.modes.filter(m=>Number.isFinite(m.gruneisen)&&m.frequencyTHz>=lo&&m.frequencyTHz<=hi);}
function aggregate(s){const values=filterModes(s).map(m=>m.gruneisen);if(!values.length)return null;switch($('gamma-bz-aggregate').value){case 'min':return Math.min(...values);case 'max':return Math.max(...values);default:return values.reduce((s,v)=>s+v,0)/values.length;}}
// Certified nearest reciprocal image: once |qG|=R is known, every better image
// satisfies |q_i+n_i| <= R |a_i| / 2π. Works for nonorthogonal cells too.
function fold(q,geometry,cell){const B=root.BrillouinZone,initial=root.BrillouinZone.cart(q,geometry.reciprocal),R=Math.hypot(...initial),bounds=cell.map(a=>R*Math.hypot(...a)/(2*Math.PI)+1e-9);let best=initial,d=R*R;
 const lows=q.map((v,i)=>Math.ceil(-bounds[i]-v)),highs=q.map((v,i)=>Math.floor(bounds[i]-v));
 if(highs.reduce((n,x,i)=>n*(x-lows[i]+1),1)>200000)throw Error('Reciprocal cell too ill-conditioned for 1BZ folding.');
 for(let i=lows[0];i<=highs[0];i++)for(let j=lows[1];j<=highs[1];j++)for(let k=lows[2];k<=highs[2];k++){const p=B.cart([q[0]+i,q[1]+j,q[2]+k],geometry.reciprocal),dd=p.reduce((s,x)=>s+x*x,0);if(dd<d-1e-12){best=p;d=dd;}}return best;
}
function draw(){
 if(!record||view!=='mesh')return;
 $('gamma-bz-content').hidden=false;
 const values=record.samples.map(aggregate),finite=values.filter(Number.isFinite),abs=finite.map(Math.abs).sort((a,b)=>a-b),manual=Number($('gamma-bz-limit').value),limit=manual>0?manual:Math.max(1e-6,abs[Math.floor((abs.length-1)*.95)]||1);
 const g=root.BrillouinZone.geometry(owner.result.lattice),points=record.samples.map((s,i)=>({position:fold(s.q,g,owner.result.lattice),color:color(values[i],limit),q:s.q}));
 if(!bz)bz=root.BrillouinZone.create($('gamma-bz-canvas'),i=>chooseQ(i).catch(e=>status(e.message)));
 const camera=bz.getView();bz.loadGeometry({points,pointCloud:true,faces:g.faces,radius:g.radius,selected:selectedQ,axes:g.reciprocal.map((b,i)=>({label:['a*','b*','c*'][i],ends:[[0,0,0],b.map(x=>x*.6)]}))});bz.restore(camera);
 const undefinedCount=record.samples.reduce((n,s)=>n+s.modes.filter(m=>!Number.isFinite(m.gruneisen)).length,0),imaginary=record.samples.reduce((n,s)=>n+s.modes.filter(m=>m.mask==='imaginary').length,0);
 $('gamma-bz-scale').textContent=`${record.label} · −${limit.toPrecision(3)} → 0 → +${limit.toPrecision(3)} · ${values.filter(v=>Number.isFinite(v)&&Math.abs(v)>limit).length} clipped colors · ${undefinedCount} undefined modes (${imaginary} imaginary)`;
 $('gamma-bz-warning').hidden=!imaginary;$('gamma-bz-warning').textContent=`${imaginary} imaginary modes: γ is undefined. This mesh does not establish dynamical stability.`;
 inspector();controls();
}
function inspector(){
 const s=record?.samples[selectedQ];if(!s)return;
 const valid=filterModes(s),a=aggregate(s),name=$('gamma-bz-aggregate').selectedOptions[0].textContent;
 $('gamma-bz-q').textContent=`q (${s.q.map(x=>x.toFixed(4)).join(', ')}) · ${record.label} ${name}: ${Number.isFinite(a)?a.toFixed(5):'undefined'} · valid ${valid.length}/${s.modes.length}`;
 const exact=owner.result.qpoints.findIndex(p=>p.q.every((x,i)=>Math.abs(x-s.q[i])<1e-8));$('gamma-bz-path-note').textContent=exact<0?'Mesh q-point outside the displayed band path.':'Also sampled on the band path.';
 $('gamma-bz-q-index').max=String(record.samples.length);$('gamma-bz-q-index').value=String(selectedQ+1);
 const list=$('gamma-bz-bars');list.replaceChildren();const max=Math.max(1e-6,...s.modes.map(m=>Math.abs(m.gruneisen||0)));
 for(const [i,m] of s.modes.entries()){
  const button=document.createElement('button');button.type='button';button.className='gamma-bz-mode';button.dataset.mode=String(i);button.setAttribute('aria-pressed',String(i===selectedMode));button.setAttribute('aria-label',`Mode ${i+1}, ${m.frequencyTHz.toFixed(4)} THz, γ ${m.gruneisen??m.mask}`);
  const label=document.createElement('span');label.textContent=`${i+1} · ${m.frequencyTHz.toFixed(2)} THz`;
  const track=document.createElement('span');track.className='gamma-bz-track';const bar=document.createElement('i');const width=Number.isFinite(m.gruneisen)?Math.abs(m.gruneisen)/max*49:0;bar.style.cssText=`left:${m.gruneisen<0?50-width:50}%;width:${width}%;background:${color(m.gruneisen,max)}`;track.append(bar);
  const value=document.createElement('span');value.textContent=Number.isFinite(m.gruneisen)?m.gruneisen.toFixed(3):'—';button.append(label,track,value);button.onclick=()=>chooseMode(i).catch(e=>status(e.message));list.append(button);
 }
 const m=s.modes[selectedMode];$('gamma-bz-selection').textContent=`Mode ${selectedMode+1} · ${m.frequencyTHz.toFixed(5)} THz · ${record.label} ${Number.isFinite(m.gruneisen)?m.gruneisen.toFixed(6):'undefined · '+m.mask}${m.degeneracy>1?' · '+m.degeneracy+'-fold derivative subspace':''}`;
}
async function chooseQ(i){
 if(!record?.samples[i])return;selectedQ=i;selectedMode=Math.min(selectedMode,record.samples[i].modes.length-1);vectors=null;$('gamma-bz-crystal').style.visibility='hidden';$('gamma-bz-vibration-note').textContent='Preparing the selected q eigenvectors from saved force constants…';modeWorker?.terminate();modeWorker=null;bz?.select(i,0);inspector();await loadVectors();
}
async function chooseMode(i){selectedMode=i;inspector();if(vectors)motion();else await loadVectors();}
function request(c){return {structure:owner.preparedInput,settings:{...owner.settings,nacEnabled:false},project:{tasks:c.tasks.map(t=>({status:t.status,settings:t.settings,result:{geometry:t.result.geometry,qhaSha256:t.result.qhaSha256,qha:{forceConstants:t.result.qha.forceConstants,volumeAngstrom3:t.result.qha.volumeAngstrom3}}}))},group:c.group,stepPercent:c.stepPercent,centerForceConstants:c.group?owner.forceConstants:undefined};}
async function loadVectors(){
 if(!record||worker)return;const source=owner,q=selectedQ,key=record.key,c=context(record.metric);if(await binding(c,record.mesh)!==key){status('Strain settings changed. Choose Plot γ in 1BZ to apply them.');return;}
 modeWorker?.terminate();const w=new Worker('./phonon-worker.js?v=a17c702958db7f24'),id=crypto.randomUUID();modeWorker=w;
 const base=request(c);base.centerHash=await H().hash(owner.forceConstants);
 w.onerror=e=>{if(modeWorker===w){modeWorker=null;w.terminate();status(e.message);}};
 w.onmessage=({data:m})=>{if(modeWorker!==w||owner!==source||selectedQ!==q||record?.key!==key||m.jobId!==id)return;if(m.type==='error'){modeWorker=null;w.terminate();status(m.message);}if(m.type==='gruneisen-result'){vectors=m.result.samples[0].modes;modeWorker=null;w.terminate();motion();}};
 w.postMessage({...base,type:c.group?'directional-gruneisen':'gruneisen',jobId:id,qpoints:[record.samples[q].q]});
}
function motion(){
 if(!vectors||view!=='mesh'||!owner)return;
 $('gamma-bz-crystal').style.visibility='visible';
 if(!viewer)viewer=root.CrystalViewer.create($('gamma-bz-crystal'),{onSelect:()=>{}});
 const data={...owner.result,hasEigenvectors:true,qpoints:[{q:record.samples[selectedQ].q,bands:vectors}]};
 const structure=root.PhononBand.visualizationFrame(data,{qIndex:0,modeIndex:selectedMode,repeats:[2,2,2],phase,amplitude:.15,equilibrium:false});
 viewer.setFrame({structure,display:{...root.CommonDisplay.frame(),stylePreset:'phonon-vesta',showCell:true,showBonds:true,showVectors:true,vectorScale:.8,repeats:[1,1,1]},atomDragEnabled:false,interactionMode:'rotate'});
 $('gamma-bz-vibration-note').textContent='Selected mesh mode · 2×2×2 display · mass-weighted derivative eigenvector';
}
function tick(t){if(!playing||view!=='mesh'||document.hidden){last=0;return;}phase+=last?Math.min(t-last,80)*.003:0;last=t;motion();frame=requestAnimationFrame(tick);}
async function start(){
 if(worker||busy||!owner)return;
 try{
  const source=owner,c=context(),m=mesh(),total=m.reduce((a,b)=>a*b,1),n=owner.result.atoms.length*3;
  if(m.some(x=>!Number.isInteger(x)||x<2||x>31)||total*n>(compact()?100000:500000))throw Error('Use mesh sizes 2–31 and fewer q-mode values (100,000 on touch/mobile, 500,000 desktop).');
  const key=await binding(c,m);if(owner!==source)return;
  cancel();record=records.get(key)||{schema:'macer-gruneisen-bz-v1',key,configurationHash:owner.configurationHash,metric:$('gamma-bz-metric').value,label:c.label,mesh:m,total,samples:[],metadata:null};records.set(key,record);let retained=0;for(const [k,r] of [...records].reverse()){retained+=r.total*n;if(retained>(compact()?200000:1000000)||records.size>12){if(k!==key)records.delete(k);}}
  selectedQ=Math.min(selectedQ,record.samples.length-1);if(selectedQ<0)selectedQ=0;vectors=null;
  if(record.samples.length===total){if(innerWidth<701)$('gamma-bz-settings').open=false;draw();status(`${total} q-points cached · 0 new force evaluations · no mesh recalculation`);await chooseQ(selectedQ);return;}
  $('gamma-bz-content').hidden=true;
  const w=new Worker('./phonon-worker.js?v=a17c702958db7f24'),id=crypto.randomUUID(),token=++epoch;worker=w;modeWorker?.terminate();modeWorker=null;controls();
  status(`Postprocessing ${record.samples.length}/${total} q-points · saved force constants · 0 new force evaluations`);
  const fail=text=>{if(worker!==w)return;w.terminate();worker=null;status(text);controls();};w.onerror=e=>fail(e.message);
  w.onmessage=async({data:r})=>{if(worker!==w||owner!==source||epoch!==token||r.jobId!==id)return;
   if(r.type==='error')fail(r.message);
   if(r.type==='gruneisen-mesh-chunk'){if(r.start!==record.samples.length){fail('Unexpected mesh checkpoint order.');return;}record.samples.push(...r.samples);record.metadata=r.metadata;status(`Postprocessing ${record.samples.length}/${total} q-points · 0 new force evaluations`);}
   if(r.type==='gruneisen-mesh-complete'){try{record.dataSha256=await digest(record);}catch(e){fail(e.message);return;}if(worker!==w||epoch!==token)return;w.terminate();worker=null;if(innerWidth<701)$('gamma-bz-settings').open=false;status(`${total} q-points completed · saved force constants reused · 0 new force evaluations`);draw();chooseQ(0).catch(e=>status(e.message));}
  };
  w.postMessage({...request(c),type:'gruneisen-mesh',jobId:id,mesh:m,completed:record.samples.length,centerHash:await H().hash(owner.forceConstants)});
 }catch(e){status(e.message);controls();}
}
$('gamma-bz-open').onclick=()=>switchView('mesh');$('gamma-bz-band').onclick=()=>switchView('band');$('gamma-bz-start').onclick=start;
$('gamma-bz-stop').onclick=()=>{cancel();status(`Stopped · ${record?.samples.length||0} q-points retained. Resume uses completed points.`);};
for(const id of ['gamma-bz-aggregate','gamma-bz-limit','gamma-bz-frequency-min','gamma-bz-frequency-max'])$(id).oninput=()=>{if(record)draw();};
$('gamma-bz-metric').onchange=()=>{cancel();status('Choose Plot γ in 1BZ to apply this metric. Previous map is retained with its original label.');};
for(const a of ['a','b','c'])$('gamma-bz-mesh-'+a).oninput=()=>{cancel();status('Mesh changed. Choose Plot γ in 1BZ to apply.');};
$('gamma-bz-q-index').onchange=()=>chooseQ(Math.max(0,Math.min(record.samples.length-1,Number($('gamma-bz-q-index').value)-1)));
$('gamma-bz-fit').onclick=()=>bz?.fit();$('gamma-bz-motion-fit').onclick=()=>viewer?.fitCamera();
$('gamma-bz-play').onclick=()=>{playing=!playing;$('gamma-bz-play').textContent=playing?'Pause vibration':'Play vibration';cancelAnimationFrame(frame);last=0;if(playing)frame=requestAnimationFrame(tick);};
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&playing&&view==='mesh'){last=0;frame=requestAnimationFrame(tick);}});
$('gamma-bz-export').onclick=()=>{if(!record)return;const url=URL.createObjectURL(new Blob([JSON.stringify(record)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='gruneisen-1bz.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
function projectFields(current){return current===owner&&record?.dataSha256?{gruneisenBz:{schema:'macer-gruneisen-bz-cache-v1',records:[...records.values()].filter(r=>r.dataSha256),selectedKey:record?.key,selectedQ,selectedMode}}:{};}
async function restore(current,saved){
 if(!saved)return;options();for(const r of saved.records){const c=context(r.metric);if(r.configurationHash!==current.configurationHash||await binding(c,r.mesh)!==r.key)throw Error('1BZ cache does not match the saved force constants.');}
 records=new Map(saved.records.map(r=>[r.key,r]));record=records.get(saved.selectedKey)||null;selectedQ=saved.selectedQ;selectedMode=saved.selectedMode;if(record){$('gamma-bz-metric').value=record.metric;['a','b','c'].forEach((a,i)=>$('gamma-bz-mesh-'+a).value=record.mesh[i]);status('Saved 1BZ mesh reopened · no recalculation');if(view==='mesh')draw();}controls();
}
async function validateSaved(p){const saved=p.gruneisenBz;if(!saved)return null;if(saved.schema!=='macer-gruneisen-bz-cache-v1'||!Array.isArray(saved.records)||saved.records.length>12)throw Error('Invalid 1BZ cache.');let count=0;for(const r of saved.records){if(r.schema!=='macer-gruneisen-bz-v1'||r.configurationHash!==p.configurationHash||r.mesh?.length!==3||r.mesh.some(x=>!Number.isInteger(x)||x<2||x>31)||r.total!==r.mesh.reduce((a,b)=>a*b,1)||!Array.isArray(r.samples)||r.samples.length>r.total)throw Error('Invalid 1BZ mesh data.');if(!r.dataSha256||r.dataSha256!==await digest(r))throw Error('Saved 1BZ checksum mismatch.');const step=r.metric==='volume'?(r.metadata.volumeRatios[2]-1)*100:r.metadata.analysis.stepPercent;const stored=r.metric==='volume'?[p.volumeGruneisenWorkflow?.volumes,p.qhaWorkflow?.volumes].find(v=>r.metadata.sourceHashes?.every(h=>v?.tasks.some(t=>t.result?.qhaSha256===h))):p.directionalGruneisen?.project;const tasks=r.metric==='volume'?[1-step/100,1,1+step/100].map(ratio=>stored?.tasks.find(t=>Math.abs(t.settings.volumeRatio-ratio)<1e-9&&t.status==='completed')):[-1,1].map(sign=>stored?.tasks.find(t=>t.settings.analysis.group===r.metric&&t.settings.analysis.sign===sign&&t.settings.analysis.stepPercent===step&&t.status==='completed'));const key=JSON.parse(r.key);if(tasks.some(t=>!t)||key[0]!==p.configurationHash||key[1]!==await H().hash(p.forceConstants)||key[2]!==r.metric||Math.abs(key[3]-step)>1e-9||JSON.stringify(key[4])!==JSON.stringify(tasks.map(t=>t.result.qhaSha256))||JSON.stringify(key[5])!==JSON.stringify(r.mesh))throw Error('Saved 1BZ force-constant identity mismatch.');count+=r.samples.length*(p.result?.atoms.length||0)*3;for(const s of r.samples)if(s.q?.length!==3||s.q.some(x=>!Number.isFinite(x))||s.modes?.length!==p.result.atoms.length*3||s.modes.some(m=>!Number.isFinite(m.frequencyTHz)||m.gruneisen!==null&&!Number.isFinite(m.gruneisen)||m.eigenvector))throw Error('Invalid 1BZ mode values.');}if(count>1000000)throw Error('1BZ cache exceeds memory budget.');const r=saved.records.find(r=>r.key===saved.selectedKey);if(!r||!Number.isInteger(saved.selectedQ)||!Number.isInteger(saved.selectedMode)||!r.samples[saved.selectedQ]?.modes[saved.selectedMode])throw Error('Invalid 1BZ selection.');return saved;}
root.addEventListener('resize',()=>{if(innerWidth<701&&view==='mesh'&&record?.samples.length===record?.total)$('gamma-bz-settings').open=false;});
root.PhononGruneisenBz={setSource,projectFields,validateSaved,restore,fold,setBusy:v=>{busy=v;if(v)cancel();controls();},getState:()=>({record,selectedQ,selectedMode,vectors,view,running:!!worker,points:bz?.projectedPoints(),camera:bz?.getView()})};
})(globalThis);
