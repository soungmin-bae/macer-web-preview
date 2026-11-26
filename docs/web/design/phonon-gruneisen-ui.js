/* Explore stored volume force constants on the displayed phonon path. */
(function(root){
'use strict';
const $=id=>document.getElementById(id);
const colors=['#176ba0','#b14e3c','#397b64','#8763a8','#b17b21','#547c9a'];
const workerUrl='./phonon-worker.js?v=a17c702958db7f24';
let owner=null,project=null,result=null,worker=null,busy=false,selection={qIndex:0,modeIndex:0},resultHash=null;
let branchOrders=[],chartHits=new Map(),volumeRecord=null;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function svg(tag,attrs={},text){
 const el=document.createElementNS('http://www.w3.org/2000/svg',tag);
 for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);
 if(text!==undefined)el.textContent=text;
 return el;
}
function ratios(){const step=$('gruneisen-step').valueAsNumber;return [1-step/100,1,1+step/100];}
function selectedTasks(){return ratios().map(r=>project?.tasks.find(t=>Math.abs(t.settings.volumeRatio-r)<1e-9&&t.status==='completed'));}
function controls(){
 root.PhononDirectionalUi?.refreshOptions();
 $('phonon-band-color').querySelector('[value=gruneisen]').disabled=!volumeRecord;
 $('phonon-gruneisen-panel').hidden=!owner;
 $('phonon-open-gruneisen').hidden=!owner;
 const tasks=selectedTasks(),ready=tasks.every(Boolean);
 const step=$('gruneisen-step').valueAsNumber;
 const valid=Number.isFinite(step)&&step>=.1&&step<=10;
 $('qha-gruneisen').disabled=!owner||!ready||!!worker||busy||!valid;
 $('gruneisen-step').disabled=!!worker||busy;
 $('gruneisen-stop').disabled=!worker;
 $('gruneisen-prepare').hidden=ready||!owner;
 $('gruneisen-volumes').textContent=owner&&valid?ratios().map((r,i)=>`${r.toFixed(4)} V₀ · ${tasks[i]?'saved':'needed'}`).join('   /   '):'Choose a volume interval from 0.1% to 10%.';
}
$('phonon-open-gruneisen').onclick=()=>{const panel=$('phonon-gruneisen-panel');panel.open=true;panel.scrollIntoView({block:'start'});};
function stop(){worker?.terminate();worker=null;controls();}
function clear(){stop();volumeRecord=null;result=null;resultHash=null;branchOrders=[];root.PhononBand?.setGruneisen?.(null);$('gruneisen-result').hidden=true;root.PhononBand?.setSelectedModeOverride?.(null);}
function setSource(next,volumes){
 const supported=next?.result?.qpoints?.length&&next.result.kind!=='gamma-spectroscopy'?next:null;
 const ownerChanged=owner!==supported;
 const changed=ownerChanged||project?.projectId!==volumes?.projectId;
 owner=supported;project=volumes;
 root.PhononGruneisenBz?.setSource(supported,volumes);
 if(changed){clear();volumeRecord=null;}
 root.PhononDirectionalUi?.setSource(supported);
 controls();
}
// Maximum-weight one-to-one assignment. Branch labels are independent of
// frequency sorting and use all neighboring eigenvector overlaps.
function assignment(weights){
 const n=weights.length,u=Array(n+1).fill(0),v=Array(n+1).fill(0),p=Array(n+1).fill(0),way=Array(n+1).fill(0);
 for(let i=1;i<=n;i++){
  p[0]=i;let j0=0;const min=Array(n+1).fill(Infinity),used=Array(n+1).fill(false);
  do{
   used[j0]=true;const i0=p[j0];let delta=Infinity,j1=0;
   for(let j=1;j<=n;j++)if(!used[j]){
    const cost=-weights[i0-1][j-1]-u[i0]-v[j];
    if(cost<min[j]){min[j]=cost;way[j]=j0;}
    if(min[j]<delta){delta=min[j];j1=j;}
   }
   for(let j=0;j<=n;j++){if(used[j]){u[p[j]]+=delta;v[j]-=delta;}else min[j]-=delta;}
   j0=j1;
  }while(p[j0]!==0);
  do{const j1=way[j0];p[j0]=p[j1];j0=j1;}while(j0!==0);
 }
 const match=Array(n);for(let j=1;j<=n;j++)match[p[j]-1]=j-1;return match;
}
function overlap(a,b){
 let re=0,im=0;
 for(let atom=0;atom<a.length;atom++)for(let axis=0;axis<3;axis++){
  const [ar,ai]=a[atom][axis],[br,bi]=b[atom][axis];re+=ar*br+ai*bi;im+=ar*bi-ai*br;
 }
 return re*re+im*im;
}
function connect(){
 branchOrders=[];
 const starts=new Set(result.segments.map(s=>s.start));
 for(let q=0;q<result.samples.length;q++){
  const current=result.samples[q].modes;
  if(!q||starts.has(q)){branchOrders.push(current.map((_,i)=>i));continue;}
  const previous=result.samples[q-1].modes;
  const match=assignment(previous.map(a=>current.map(b=>overlap(a.eigenvector,b.eigenvector))));
  branchOrders.push(branchOrders[q-1].map(i=>match[i]));
 }
}
function draw(id,key,title){
 const plot=$(id);plot.replaceChildren(svg('title',{},title));
 const valueFor=mode=>key==='frequencyTHz'&&Math.abs(mode.frequencyTHz)<result.zeroFrequencyTHz?0:mode[key];
 const values=result.samples.flatMap(s=>s.modes.map(valueFor)).filter(Number.isFinite);
 if(!values.length){plot.append(svg('text',{x:70,y:90},'No finite values'));chartHits.set(id,[]);return;}
 const low=Math.min(0,...values),high=Math.max(0,...values),pad=Math.max((high-low)*.08,1e-5);
 const maxX=result.samples.at(-1).distance||1;
 const x=v=>70+v/maxX*805,y=v=>185-(v-low+pad)/(high-low+2*pad)*150;
 const hits=[];
 for(let i=0;i<=3;i++){
  const value=low+(high-low)*i/3;
  plot.append(svg('line',{x1:70,x2:875,y1:y(value),y2:y(value),class:'qha-plot-grid'}),svg('text',{x:61,y:y(value)+4,'text-anchor':'end'},Number(value.toPrecision(4))));
 }
 plot.append(svg('text',{x:70,y:19},title),svg('line',{x1:70,x2:875,y1:y(0),y2:y(0),class:'qha-zero-line'}));
 const starts=new Set(result.segments.map(s=>s.start));
 const ticks=new Map();
 for(const seg of result.segments)for(const i of [seg.start,seg.end]){
  const sample=result.samples[i];if(sample)ticks.set(sample.distance,sample.label||'');
 }
 for(const [distance,label] of ticks)plot.append(svg('line',{x1:x(distance),x2:x(distance),y1:30,y2:185,class:'qha-plot-grid'}),svg('text',{x:x(distance),y:211,'text-anchor':'middle'},label));
 const n=result.samples[0].modes.length;
 for(let branch=0;branch<n;branch++){
  let path='';
  result.samples.forEach((sample,q)=>{
   const m=branchOrders[q][branch],mode=sample.modes[m],value=valueFor(mode);
   if(value===null||!Number.isFinite(value)){path+=' ';return;}
   const px=x(sample.distance),py=y(value);
   const prev=q?valueFor(result.samples[q-1].modes[branchOrders[q-1][branch]]):null;
   path+=`${!q||starts.has(q)||prev===null?'M':'L'}${px},${py} `;
   hits.push({qIndex:q,modeIndex:m,x:px,y:py});
  });
  plot.append(svg('path',{d:path,fill:'none',stroke:colors[branch%colors.length],'stroke-width':1.5}));
 }
 const selected=result.samples[selection.qIndex],mode=selected.modes[selection.modeIndex],value=valueFor(mode);
 plot.append(svg('line',{x1:x(selected.distance),x2:x(selected.distance),y1:30,y2:185,class:'qha-temperature-guide'}));
 if(value!==null&&Number.isFinite(value))plot.append(svg('circle',{cx:x(selected.distance),cy:y(value),r:5,fill:'#bd4937',stroke:'white'}));
 chartHits.set(id,hits);
}
function showSelection(){
 if(!result)return;
 const sample=result.samples[selection.qIndex],mode=sample.modes[selection.modeIndex];
 $('gruneisen-selected').textContent=`${result.analysis?.label||'γ(V)'} · q (${sample.q.map(v=>v.toFixed(4)).join(', ')}) · mode ${mode.mode} · ${mode.frequencyTHz.toFixed(4)} THz · γ ${mode.gruneisen===null?'—':mode.gruneisen.toFixed(5)}`;
 $('gruneisen-quality').textContent=mode.mask==='zero-frequency'?'Translation / near-zero frequency · γ undefined':mode.mask==='imaginary'?'Imaginary mode · γ undefined':mode.degeneracy>1?`${mode.degeneracy}-fold degeneracy · derivative eigenvector`:'Equilibrium eigenvector · matrix derivative';
 root.PhononBand.setSelectedModeOverride({frequencyTHz:mode.frequencyTHz,eigenvector:mode.eigenvector});
 draw('gruneisen-frequency-plot','frequencyTHz','Frequency (THz)');
 draw('gruneisen-gamma-plot','gruneisen','Mode Grüneisen γ');
 const graphs=document.querySelector('.gruneisen-graphs');
 if(graphs.scrollWidth>graphs.clientWidth){
  const plot=$('gruneisen-gamma-plot');
  const fraction=sample.distance/(result.samples.at(-1).distance||1);
  graphs.scrollLeft=(70+805*fraction)/900*plot.getBoundingClientRect().width-graphs.clientWidth/2;
 }
}
root.addEventListener('resize',()=>{if(result)showSelection();});
function choose(qIndex,modeIndex){
 selection={qIndex,modeIndex};
 root.PhononBand.select(qIndex,modeIndex);
}
document.addEventListener('macer-phonon-selection',({detail})=>{
 if(!result||detail.source==='analytic-gamma')return;
 if(detail.qIndex>=result.samples.length||detail.modeIndex>=result.samples[0].modes.length)return;
 selection={qIndex:detail.qIndex,modeIndex:detail.modeIndex};showSelection();
});
for(const id of ['gruneisen-frequency-plot','gruneisen-gamma-plot']){
 const plot=$(id);plot.setAttribute('tabindex','0');
 plot.onclick=event=>{
  const rect=plot.getBoundingClientRect(),px=(event.clientX-rect.left)/rect.width*900,py=(event.clientY-rect.top)/rect.height*230;
  let best=null,score=Infinity;
  for(const point of chartHits.get(id)||[]){const next=(point.x-px)**2+(point.y-py)**2;if(next<score){best=point;score=next;}}
  if(best)choose(best.qIndex,best.modeIndex);
 };
 plot.onkeydown=event=>{
  if(!result||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
  event.preventDefault();
  choose(Math.max(0,Math.min(result.samples.length-1,selection.qIndex+(event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:0))),
   Math.max(0,Math.min(result.samples[0].modes.length-1,selection.modeIndex+(event.key==='ArrowDown'?-1:event.key==='ArrowUp'?1:0))));
 };
}
function present(){
 connect();root.PhononBand.setGruneisen(result,branchOrders,result.analysis?'gruneisen-'+result.analysis.id:'gruneisen');$('gruneisen-result').hidden=false;$('qha-gruneisen-download').disabled=false;
 const body=$('qha-gruneisen-table').tBodies[0];body.replaceChildren();
 for(const sample of result.samples)for(const mode of sample.modes){
  const row=body.insertRow();for(const field of [sample.q.map(v=>v.toFixed(3)).join(', '),mode.mode,mode.frequencyTHz.toFixed(5),mode.gruneisen===null?mode.mask:mode.gruneisen.toFixed(6),mode.degeneracy])row.insertCell().textContent=field;
 }
 choose(selection.qIndex,selection.modeIndex);
}
async function start(){
 if(worker||busy||!owner||!project)return;
 const step=$('gruneisen-step').valueAsNumber,tasks=selectedTasks();
 if(tasks.some(t=>!t)){controls();return;}
 if(owner.result.nac){$('qha-gruneisen-status').textContent='Choose the no-NAC dispersion before this volume analysis.';return;}
 const current=owner,volumes=project,id=crypto.randomUUID(),path=current.result;
 if(path.qpoints.length*path.atoms.length**2>200000){$('qha-gruneisen-status').textContent='Reduce the path density or primitive cell for this analysis.';return;}
 clear();
 worker=new Worker(workerUrl);const running=worker;controls();
 $('qha-gruneisen-status').textContent=`Analyzing ${path.qpoints.length} path points · reusing three saved volumes · 0 new force evaluations`;
 running.onerror=event=>{if(worker!==running)return;stop();$('qha-gruneisen-status').textContent=event.message;};
 running.onmessage=async({data:m})=>{
  if(worker!==running||m.jobId!==id||current!==owner)return;
  if(m.type==='error'){stop();$('qha-gruneisen-status').textContent=m.message;}
  if(m.type==='gruneisen-result'){
   try{
    const next={...m.result,configurationHash:current.configurationHash,
      segments:path.segments,samples:m.result.samples.map((sample,i)=>({...sample,distance:path.qpoints[i].distance,label:path.qpoints[i].label}))};
    const hash=await root.CalculationProject.hash(next);
    if(worker!==running||owner!==current||project?.projectId!==volumes.projectId)return;
    result=next;resultHash=hash;volumeRecord={result:next,sha256:hash};selection={qIndex:0,modeIndex:0};stop();present();
    $('qha-gruneisen-status').textContent=`${result.samples.length} path points · ±${step}% volume · three saved results reused · 0 new force evaluations`;
   }catch(error){stop();$('qha-gruneisen-status').textContent=error.message;}
  }
 };
 running.postMessage({type:'gruneisen',jobId:id,inputRevision:current.revision,structure:current.preparedInput,
  settings:{...current.settings,nacEnabled:false},project,qpoints:path.qpoints.map(p=>p.q),stepPercent:step});
}
$('qha-gruneisen').onclick=start;
$('gruneisen-stop').onclick=()=>{stop();$('qha-gruneisen-status').textContent='Stopped. Saved volume results remain available.';};
$('gruneisen-step').oninput=()=>{clear();controls();};
$('gruneisen-prepare').onclick=()=>{
 const panel=$('phonon-qha-panel');panel.open=true;
 $('qha-grid-mode').value='custom';
 const grid=[...new Set([...(project?.tasks.map(t=>t.settings.volumeRatio)||[.94,.96,.98,1,1.02,1.04,1.06]),...ratios().map(r=>Number(r.toFixed(10)))])].sort((a,b)=>a-b);
 $('qha-ratios').value=grid.join(', ');$('qha-grid-mode').dispatchEvent(new Event('input',{bubbles:true}));
 panel.scrollIntoView({block:'start'});$('qha-review').click();
};
$('gruneisen-show-vibration').onclick=()=>{$('phonon-viewer-area').scrollIntoView({block:'center'});};
$('qha-gruneisen-download').onclick=()=>{
 if(!result)return;const href=URL.createObjectURL(root.PhononProject.toBlob(result)),link=document.createElement('a');
 link.href=href;link.download='mode-gruneisen.json';link.click();setTimeout(()=>URL.revokeObjectURL(href),1000);
};
function projectFields(){return volumeRecord?{gruneisen:{...volumeRecord,selection}}:{};}
async function validateSaved(saved,source,volumes){
 const value=saved.result;
 if(saved.sha256!==await root.CalculationProject.hash(value)||value.configurationHash!==source.configurationHash||
  !same(value.samples.map(p=>p.q),source.result.qpoints.map(p=>p.q))||
  value.samples.some(p=>p.modes.length!==source.result.atoms.length*3)||
  !same(value.sourceHashes,value.volumeRatios.map(r=>volumes.tasks.find(t=>Math.abs(t.settings.volumeRatio-r)<1e-9)?.result.qhaSha256))||
  !Number.isInteger(saved.selection.qIndex)||!Number.isInteger(saved.selection.modeIndex)||
  !value.samples[saved.selection.qIndex]?.modes[saved.selection.modeIndex])throw Error('Saved Grüneisen result does not match this phonon path and volume triplet.');
}
function restore(saved){
 result=saved.result;resultHash=saved.sha256;volumeRecord={result,sha256:resultHash};selection=saved.selection;
 $('gruneisen-step').value=(result.volumeRatios[2]-1)*100;
 controls();present();$('phonon-gruneisen-panel').open=true;
 $('qha-gruneisen-status').textContent='Saved path Grüneisen reopened · no force evaluations';
}
function invalidateDirectional(id){if(result?.analysis?.id!==id)return;result=null;resultHash=null;branchOrders=[];$('gruneisen-result').hidden=true;root.PhononBand.setGruneisen(null);root.PhononBand.setSelectedModeOverride(null);}
function displayDirectional(value,hash){result=value;resultHash=hash;const selected=root.PhononBand.getViewSettings?.();if(selected){selection={qIndex:selected.qIndex??selection.qIndex,modeIndex:selected.modeIndex??selection.modeIndex};}present();}
document.addEventListener('macer-gruneisen-color',({detail})=>{
 if(detail.key==='gruneisen'&&volumeRecord){result=volumeRecord.result;resultHash=volumeRecord.sha256;present();}
});
root.PhononGruneisenUi={setSource,setBusy:value=>{busy=value;root.PhononGruneisenBz?.setBusy(value);controls();root.PhononDirectionalUi?.setBusy(value);},projectFields,validateSaved,restore,displayDirectional,invalidateDirectional,refreshVolumeOption:()=>{$('phonon-band-color').querySelector('[value=gruneisen]').disabled=!volumeRecord;},getSelection:()=>({...selection})};
})(globalThis);
