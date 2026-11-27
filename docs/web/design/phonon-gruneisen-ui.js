/* Explore stored volume force constants on the displayed phonon path. */
(function(root){
'use strict';
const $=id=>document.getElementById(id);
const colors=['#176ba0','#b14e3c','#397b64','#8763a8','#b17b21','#547c9a'];
const workerUrl='./phonon-worker.js?v=0a42a9a6b37116e1';
let owner=null,project=null,result=null,worker=null,busy=false,selection={qIndex:0,modeIndex:0},resultHash=null;
let dedicatedProject=null,preparing=false,lastNacKey=null;
let branchOrders=[],chartHits=new Map(),volumeRecord=null,plotView='frequency';
let gammaViewport=null,gammaGeometry=null,gammaDrag=null,gammaSuppressClick=false,gammaPlotResult=null;
function cancelGammaDrag(){const state=gammaDrag;gammaDrag=null;state?.box?.remove();const plot=$('gruneisen-gamma-plot');if(state&&plot.hasPointerCapture(state.pointer))plot.releasePointerCapture(state.pointer);}
function resetGammaZoom(){cancelGammaDrag();gammaViewport=null;if(result)showSelection();plotControls();}
$('gruneisen-q-reset-zoom').onclick=resetGammaZoom;
function plotControls(){
 const gamma=plotView==='gamma'&&!!result;
 $('gruneisen-q-reset-zoom').disabled=!gammaViewport;
 $('phonon-path-plot-title').textContent=gamma?'GRÜNEISEN γ(q)':'DISPERSION';
 $('phonon-color-label').textContent=gamma?'Metric':'Line color';
 $('phonon-path-plot-hint').textContent=gamma?'Drag a box to zoom q and γ · click / tap a curve to select its mode and 3D vibration · double-click to reset':'Drag a rectangle to zoom · click a branch to select · use + / − to zoom · double-click to reset';
 $('phonon-plot-frequency').setAttribute('aria-pressed',String(!gamma));
 $('phonon-plot-gruneisen').setAttribute('aria-pressed',String(gamma));
 $('phonon-plot-gruneisen').disabled=!result;
 $('phonon-band-plot').parentElement.hidden=gamma;
 $('phonon-gamma-scale-note').hidden=gamma;
 $('phonon-gruneisen-plot-pane').hidden=!gamma;
 for(const id of ['phonon-frequency-unit','phonon-zoom-in','phonon-zoom-out','phonon-zoom-reset','phonon-plot-save','phonon-low-frequency'])$(id).hidden=gamma;
 for(const v of ['plain','elements'])$('phonon-band-color').querySelector(`[value="${v}"]`).disabled=gamma;
}
$('phonon-plot-frequency').onclick=()=>{plotView='frequency';plotControls();};
$('phonon-plot-gruneisen').onclick=()=>{if(!result)return;plotView='gamma';if(!$('phonon-band-color').value.startsWith('gruneisen'))present();plotControls();showSelection();};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function svg(tag,attrs={},text){
 const el=document.createElementNS('http://www.w3.org/2000/svg',tag);
 for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);
 if(text!==undefined)el.textContent=text;
 return el;
}
function ratios(){const step=$('gruneisen-step').valueAsNumber;return [1-step/100,1,1+step/100].map(v=>Number(v.toFixed(10)));}
function selectedTasks(){return ratios().map(r=>project?.tasks.find(t=>Math.abs(t.settings.volumeRatio-r)<1e-9&&t.status==='completed'));}
function controls(){
 root.PhononDirectionalUi?.refreshOptions();
 plotControls();
 $('phonon-band-color').querySelector('[value=gruneisen]').disabled=!volumeRecord;
 $('phonon-gruneisen-panel').hidden=!owner;
 $('phonon-open-gruneisen').hidden=!owner;
 const tasks=selectedTasks(),ready=tasks.every(Boolean);
 const step=$('gruneisen-step').valueAsNumber;
 const valid=Number.isFinite(step)&&step>=.1&&step<=10;
 $('qha-gruneisen').textContent=preparing?'Calculating volume force constants…':ready?'Calculate γ(V) · saved volumes':'Calculate 3 volumes + γ(V)';
 $('qha-gruneisen').disabled=!owner||!!worker||busy||preparing||!valid;
 $('gruneisen-no-nac').hidden=true;
 $('gruneisen-nac-note').hidden=!owner?.result.nac;
 $('gruneisen-nac-note').textContent='NAC γ(V) · equilibrium Born charges and dielectric tensor held fixed. NAC is rebuilt at each volume; Γ approach follows the displayed band path. This omits volume-dependent tensor changes.';
 $('gruneisen-step').disabled=!!worker||busy;
 $('gruneisen-stop').disabled=!worker&&!preparing;
 $('gruneisen-prepare').hidden=true;
 $('gruneisen-volumes').textContent=owner&&valid?ratios().map((r,i)=>`${r.toFixed(4)} V₀ · ${tasks[i]?'saved':'needed'}`).join('   /   '):'Choose a volume interval from 0.1% to 10%.';
}
$('phonon-open-gruneisen').onclick=()=>{const panel=$('phonon-gruneisen-panel');panel.open=true;panel.scrollIntoView({block:'start'});};
function stop(){worker?.terminate();worker=null;controls();}
function clear(){cancelGammaDrag();gammaViewport=null;gammaGeometry=null;gammaPlotResult=null;stop();volumeRecord=null;result=null;resultHash=null;branchOrders=[];root.PhononBand?.setGruneisen?.(null);$('gruneisen-result').hidden=true;plotView='frequency';plotControls();root.PhononBand?.setSelectedModeOverride?.(null);}
function setSource(next,volumes){
 const supported=next?.result?.qpoints?.length&&next.result.kind!=='gamma-spectroscopy'?next:null;
 const ownerChanged=owner!==supported;
 const nacKey=JSON.stringify(supported?.result.nac||null);
 const changed=ownerChanged||nacKey!==lastNacKey||(!dedicatedProject&&project?.projectId!==volumes?.projectId);
 lastNacKey=nacKey;
 if(ownerChanged)dedicatedProject=null;
 owner=supported;project=dedicatedProject||volumes;
 root.PhononGruneisenBz?.setSource(supported,project);
 if(changed){clear();volumeRecord=null;$('qha-gruneisen-status').textContent=supported?'Choose Calculate to run the selected volume triplet and γ(V).':'';}
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
 const plot=$(id),isGamma=key==='gruneisen',width=isGamma&&innerWidth<600?520:900,bottom=isGamma?360:185;plot.setAttribute('viewBox',`0 0 ${width} ${isGamma?420:230}`);plot.replaceChildren(svg('title',{},title));
 const valueFor=mode=>key==='frequencyTHz'&&Math.abs(mode.frequencyTHz)<result.zeroFrequencyTHz?0:mode[key];
 const values=result.samples.flatMap(s=>s.modes.map(valueFor)).filter(Number.isFinite);
 if(!values.length){plot.append(svg('text',{x:70,y:90},'No finite values'));chartHits.set(id,[]);return;}
 const axis=Number($('gruneisen-q-range').value),extent=isGamma&&axis>0?axis:Math.max(1e-5,...values.map(Math.abs));
 const fullX=result.samples.at(-1).distance||1,xlo=isGamma&&gammaViewport?gammaViewport.xlo:0,xhi=isGamma&&gammaViewport?gammaViewport.xhi:fullX;
 const low=isGamma?(gammaViewport?.ylo??-extent):Math.min(0,...values),high=isGamma?(gammaViewport?.yhi??extent):Math.max(0,...values),pad=isGamma?0:Math.max((high-low)*.08,1e-5);
 if(isGamma){
  const visible=result.samples.filter(p=>p.distance>=xlo&&p.distance<=xhi).flatMap(p=>p.modes),outside=visible.filter(m=>Number.isFinite(m.gruneisen)&&(m.gruneisen<low||m.gruneisen>high)).length,undefinedCount=visible.filter(m=>!Number.isFinite(m.gruneisen)).length;
  $('gruneisen-q-range-note').textContent=(gammaViewport?`Zoom · q path ${xlo.toFixed(4)}–${xhi.toFixed(4)} · γ ${low.toFixed(4)}–${high.toFixed(4)} · `:'')+`${outside?outside+' values outside the γ range':'All finite values within the γ range'} · ${undefinedCount} undefined points omitted`;
  const next={source:result,xlo,xhi,ylo:low,yhi:high,left:70,right:width-25,top:35,bottom};
  if(gammaDrag&&Object.keys(next).some(k=>next[k]!==gammaDrag.geometry[k])){gammaSuppressClick=true;cancelGammaDrag();}
  gammaGeometry=next;for(const [key,v] of Object.entries({qMin:xlo,qMax:xhi,gammaMin:low,gammaMax:high}))plot.dataset[key]=v;
  $('gruneisen-q-reset-zoom').disabled=!gammaViewport;
 }
 const sorted=values.map(Math.abs).sort((a,b)=>a-b),manual=Number($('phonon-gamma-limit').value),limit=Number.isFinite(manual)&&manual>0?manual:sorted[Math.floor((sorted.length-1)*.95)]||1;
 const gammaColor=value=>{const end=value<0?[47,88,171]:[202,58,49],t=Math.min(1,Math.abs(value)/limit);return '#'+end.map(v=>Math.round(250+(v-250)*t).toString(16).padStart(2,'0')).join('');};
 const x=v=>70+(v-xlo)/(xhi-xlo)*(width-95),y=v=>bottom-(v-low+pad)/(high-low+2*pad)*(bottom-35);
 const hits=[];
 for(let i=0;i<=4;i++){
  const value=low+(high-low)*i/4;
  plot.append(svg('line',{x1:70,x2:width-25,y1:y(value),y2:y(value),class:'qha-plot-grid'}),svg('text',{x:61,y:y(value)+4,'text-anchor':'end'},Number(value.toPrecision(4))));
 }
 plot.append(svg('text',{x:70,y:19},title));if(low<=0&&high>=0)plot.append(svg('line',{x1:70,x2:width-25,y1:y(0),y2:y(0),class:'qha-zero-line'}));
 const starts=new Set(result.segments.map(s=>s.start));
 const ticks=new Map();
 for(const seg of result.segments)for(const i of [seg.start,seg.end]){
  const sample=result.samples[i];if(sample&&sample.distance>=xlo&&sample.distance<=xhi)ticks.set(sample.distance,sample.label||'');
 }
 if(isGamma&&gammaViewport)for(const distance of [xlo,xhi])if(![...ticks.keys()].some(v=>Math.abs(v-distance)<(xhi-xlo)*.025))ticks.set(distance,distance.toFixed(3));
 for(const [distance,label] of ticks)plot.append(svg('line',{x1:x(distance),x2:x(distance),y1:30,y2:bottom,class:'qha-plot-grid'}),svg('text',{x:x(distance),y:bottom+25,'text-anchor':'middle'},label));
 if(isGamma)plot.append(svg('text',{x:18,y:bottom/2,transform:`rotate(-90 18 ${bottom/2})`,'text-anchor':'middle'},'Grüneisen parameter γ'),svg('text',{x:width/2,y:bottom+52,'text-anchor':'middle'},'Band path q'));
 const clipId=id+'-clip',curves=svg('g',isGamma?{'clip-path':`url(#${clipId})`}:{});
 if(isGamma){const defs=svg('defs'),clip=svg('clipPath',{id:clipId});clip.append(svg('rect',{x:70,y:35,width:width-95,height:bottom-35}));defs.append(clip);plot.append(defs,curves);}
 const n=result.samples[0].modes.length;
 for(let branch=0;branch<n;branch++){
  let path='';
  result.samples.forEach((sample,q)=>{
   const m=branchOrders[q][branch],mode=sample.modes[m],value=valueFor(mode);
   if(value===null||!Number.isFinite(value)){path+=' ';return;}
   const px=x(sample.distance),py=y(value);
   const prev=q?valueFor(result.samples[q-1].modes[branchOrders[q-1][branch]]):null;
   path+=`${!q||starts.has(q)||prev===null?'M':'L'}${px},${py} `;
   if(!isGamma||(sample.distance>=xlo&&sample.distance<=xhi&&value>=low&&value<=high))hits.push({qIndex:q,modeIndex:m,x:px,y:py});
   if(isGamma&&q&&!starts.has(q)&&prev!==null&&Number.isFinite(prev))curves.append(svg('line',{x1:x(result.samples[q-1].distance),y1:y(prev),x2:px,y2:py,stroke:gammaColor((prev+value)/2),'stroke-width':1.8,'data-q-index':q,'data-mode-index':m}));
  });
  if(!isGamma)plot.append(svg('path',{d:path,fill:'none',stroke:colors[branch%colors.length],'stroke-width':1.5}));
 }
 const selected=result.samples[selection.qIndex],mode=selected.modes[selection.modeIndex],value=valueFor(mode);
 if(selected.distance>=xlo&&selected.distance<=xhi)plot.append(svg('line',{x1:x(selected.distance),x2:x(selected.distance),y1:30,y2:bottom,class:'qha-temperature-guide'}));
 if(value!==null&&Number.isFinite(value)&&(!isGamma||(selected.distance>=xlo&&selected.distance<=xhi&&value>=low&&value<=high)))plot.append(svg('circle',{cx:x(selected.distance),cy:y(value),r:5,fill:'#bd4937',stroke:'white'}));
 chartHits.set(id,hits);
}
function showSelection(){
 if(!result)return;
 const sample=result.samples[selection.qIndex],mode=sample.modes[selection.modeIndex];
 $('gruneisen-selected').textContent=`${result.analysis?.label||'γ(V)'} · q (${sample.q.map(v=>v.toFixed(4)).join(', ')}) · mode ${mode.mode} · ${mode.frequencyTHz.toFixed(4)} THz · γ ${mode.gruneisen===null?'—':mode.gruneisen.toFixed(5)}`;
 $('gruneisen-quality').textContent=mode.mask==='zero-frequency'?'Translation / near-zero frequency · γ undefined':mode.mask==='imaginary'?'Imaginary mode · γ undefined':mode.degeneracy>1?`${mode.degeneracy}-fold degeneracy · derivative eigenvector`:'Equilibrium eigenvector · matrix derivative';
 root.PhononBand.setSelectedModeOverride({frequencyTHz:mode.frequencyTHz,eigenvector:mode.eigenvector});
 draw('gruneisen-frequency-plot','frequencyTHz','Frequency (THz)');
 draw('gruneisen-gamma-plot','gruneisen',result.analysis?.label||'γ(V)');
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
  if(id==='gruneisen-gamma-plot'&&gammaSuppressClick){gammaSuppressClick=false;return;}
  const matrix=plot.getScreenCTM();if(!matrix)return;const local=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse()),px=local.x,py=local.y;
  if(id==='gruneisen-gamma-plot'&&(!gammaGeometry||px<gammaGeometry.left||px>gammaGeometry.right||py<gammaGeometry.top||py>gammaGeometry.bottom))return;
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
// Pointer capture keeps the selection stable outside the SVG. The gesture
// changes only view bounds; it never selects a mode or invokes a worker.
{
 const plot=$('gruneisen-gamma-plot');
 const position=e=>{const matrix=plot.getScreenCTM();return matrix?new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse()):null;};
 const clamp=(v,g)=>({x:Math.max(g.left,Math.min(g.right,v.x)),y:Math.max(g.top,Math.min(g.bottom,v.y))});
 const axes=(e,s)=>({x:Math.abs(e.clientX-s.clientX)>=6,y:Math.abs(e.clientY-s.clientY)>=6});
 plot.addEventListener('pointerdown',e=>{
  if(e.button!==0||!result||!gammaGeometry)return;const v=position(e),g=gammaGeometry;
  if(!v||v.x<g.left||v.x>g.right||v.y<g.top||v.y>g.bottom)return;
  cancelGammaDrag();gammaSuppressClick=false;gammaDrag={pointer:e.pointerId,start:clamp(v,g),geometry:{...g},clientX:e.clientX,clientY:e.clientY};plot.setPointerCapture(e.pointerId);
 });
 plot.addEventListener('pointermove',e=>{
  const s=gammaDrag;if(!s||s.pointer!==e.pointerId)return;const v=position(e);if(!v)return;const moved=axes(e,s),g=s.geometry,end=clamp(v,g);
  if(!moved.x&&!moved.y&&!s.box)return;e.preventDefault();gammaSuppressClick=true;
  if(!s.box){s.box=svg('rect',{'data-gamma-zoom-box':'',fill:'#197bb5','fill-opacity':.15,stroke:'#197bb5','stroke-width':1.5,'pointer-events':'none','aria-hidden':'true'});plot.append(s.box);}
  const left=moved.x?Math.min(s.start.x,end.x):g.left,right=moved.x?Math.max(s.start.x,end.x):g.right,top=moved.y?Math.min(s.start.y,end.y):g.top,bottom=moved.y?Math.max(s.start.y,end.y):g.bottom;
  for(const [key,value] of Object.entries({x:left,y:top,width:right-left,height:bottom-top}))s.box.setAttribute(key,value);
 });
 plot.addEventListener('pointerup',e=>{
  const s=gammaDrag;if(!s||s.pointer!==e.pointerId)return;const v=position(e),g=s.geometry,moved=axes(e,s);cancelGammaDrag();
  if(!v||g.source!==result||(!moved.x&&!moved.y))return;
  const end=clamp(v,g),q=x=>g.xlo+(x-g.left)/(g.right-g.left)*(g.xhi-g.xlo),value=y=>g.yhi-(y-g.top)/(g.bottom-g.top)*(g.yhi-g.ylo);
  const next={xlo:moved.x?q(Math.min(s.start.x,end.x)):g.xlo,xhi:moved.x?q(Math.max(s.start.x,end.x)):g.xhi,ylo:moved.y?value(Math.max(s.start.y,end.y)):g.ylo,yhi:moved.y?value(Math.min(s.start.y,end.y)):g.yhi};
  gammaSuppressClick=true;
  if(next.xhi-next.xlo<=1e-10||next.yhi-next.ylo<=1e-10)return;
  gammaViewport=next;showSelection();plotControls();
 });
 plot.addEventListener('pointercancel',()=>{gammaSuppressClick=true;cancelGammaDrag();});
 plot.addEventListener('lostpointercapture',()=>{if(gammaDrag){gammaSuppressClick=true;cancelGammaDrag();}});
 plot.addEventListener('dblclick',e=>{e.preventDefault();resetGammaZoom();});
}
function present(){
 if(gammaPlotResult!==result){cancelGammaDrag();gammaViewport=null;gammaPlotResult=result;}
 connect();plotControls();root.PhononBand.setGruneisen(result,branchOrders,result.analysis?'gruneisen-'+result.analysis.id:'gruneisen');$('gruneisen-result').hidden=false;$('qha-gruneisen-download').disabled=false;
 const body=$('qha-gruneisen-table').tBodies[0];body.replaceChildren();
 for(const sample of result.samples)for(const mode of sample.modes){
  const row=body.insertRow();for(const field of [sample.q.map(v=>v.toFixed(3)).join(', '),mode.mode,mode.frequencyTHz.toFixed(5),mode.gruneisen===null?mode.mask:mode.gruneisen.toFixed(6),mode.degeneracy])row.insertCell().textContent=field;
 }
 choose(selection.qIndex,selection.modeIndex);
}
async function start(){
 if(worker||busy||preparing||!owner)return;
 const interval=$('gruneisen-step').valueAsNumber;
 if(!Number.isFinite(interval)||interval<.1||interval>10)return;
 if(owner.result.qpoints.length*owner.result.atoms.length**2>200000){$('qha-gruneisen-status').textContent='Reduce the path density or primitive cell for this analysis.';return;}
 if(selectedTasks().some(t=>!t)){
  const current=owner;preparing=true;clear();controls();
  try{
   const completed=await root.PhononQha.calculateGruneisenVolumes(ratios(),message=>{$('qha-gruneisen-status').textContent=message;});
   if(owner!==current)return;
   dedicatedProject=completed;project=completed;root.PhononGruneisenBz?.setSource(owner,completed);
  }catch(error){$('qha-gruneisen-status').textContent=error.name==='AbortError'?'Stopped. Calculate again to start a fresh volume triplet.':error.message;return;}
  finally{preparing=false;controls();}
 }
 const step=$('gruneisen-step').valueAsNumber,tasks=selectedTasks();
 if(tasks.some(t=>!t)){controls();return;}
 const current=owner,volumes=project,id=crypto.randomUUID(),path=current.result;
 if(path.qpoints.length*path.atoms.length**2>200000){$('qha-gruneisen-status').textContent='Reduce the path density or primitive cell for this analysis.';return;}
 clear();
 worker=new Worker(workerUrl);const running=worker;controls();
 $('qha-gruneisen-status').textContent=`Analyzing ${path.qpoints.length} path points · reusing three saved volumes · 0 new force evaluations`;
 running.onerror=event=>{if(worker!==running)return;stop();$('qha-gruneisen-status').textContent=event.message;};
 running.onmessage=async({data:m})=>{
  if(worker!==running||m.jobId!==id||current!==owner)return;
  if(m.type==='gruneisen-progress')$('qha-gruneisen-status').textContent=m.stage;
  if(m.type==='error'){stop();$('qha-gruneisen-status').textContent=m.message;}
  if(m.type==='gruneisen-result'){
   try{
    const next={...m.result,configurationHash:current.configurationHash,displayNac:JSON.parse(JSON.stringify(path.nac||null)),
      segments:path.segments,samples:m.result.samples.map((sample,i)=>({...sample,distance:path.qpoints[i].distance,label:path.qpoints[i].label}))};
    const hash=await root.CalculationProject.hash(next);
    if(worker!==running||owner!==current||project?.projectId!==volumes.projectId)return;
    result=next;resultHash=hash;volumeRecord={result:next,sha256:hash};selection={qIndex:0,modeIndex:0};stop();present();
    $('qha-gruneisen-status').textContent=`${result.samples.length} path points · ±${step}% volume · three saved results reused · 0 new force evaluations${result.nac?' · NAC: fixed equilibrium tensors':''}`;
   }catch(error){stop();$('qha-gruneisen-status').textContent=error.message;}
  }
 };
 running.postMessage({type:'gruneisen',jobId:id,inputRevision:current.revision,structure:current.preparedInput,
  settings:{...current.settings,nacEnabled:!!path.nac},project,qpoints:path.qpoints.map(p=>p.q),pathPoints:path.qpoints.map(p=>({q:p.q,...(p.nacDirection?{nacDirection:p.nacDirection}:{})})),stepPercent:step});
}
$('qha-gruneisen').onclick=start;
$('gruneisen-stop').onclick=()=>{if(preparing)root.PhononQha.stop();stop();$('qha-gruneisen-status').textContent='Stopped. Saved volume results remain available.';};
$('gruneisen-step').oninput=()=>{clear();controls();};
$('gruneisen-no-nac').onclick=()=>{
 const toggle=$('phonon-result-nac-toggle');toggle.checked=false;toggle.dispatchEvent(new Event('change'));
 controls();$('qha-gruneisen-status').textContent='Saved no-NAC dispersion selected. Calculate γ(V) below.';
};
$('gruneisen-show-vibration').onclick=()=>{$('phonon-viewer-area').scrollIntoView({block:'center'});};
$('qha-gruneisen-download').onclick=()=>{
 if(!result)return;const href=URL.createObjectURL(root.PhononProject.toBlob(result)),link=document.createElement('a');
 link.href=href;link.download='mode-gruneisen.json';link.click();setTimeout(()=>URL.revokeObjectURL(href),1000);
};
function projectFields(standalone=false){return volumeRecord&&(!dedicatedProject||standalone)?{gruneisen:{...volumeRecord,selection}}:{};}
async function validateSaved(saved,source,volumes){
 const value=saved.result;
 if(saved.sha256!==await root.CalculationProject.hash(value)||value.configurationHash!==source.configurationHash||
  !same(value.displayNac||null,source.result.nac||null)||
  (!!source.result.nac&&(!value.nac||!same(value.samples.map(p=>p.nacDirection||null),source.result.qpoints.map(p=>p.nacDirection||null))))||
  !same(value.samples.map(p=>p.q),source.result.qpoints.map(p=>p.q))||
  value.samples.some(p=>p.modes.length!==source.result.atoms.length*3)||
  !same(value.sourceHashes,value.volumeRatios.map(r=>volumes.tasks.find(t=>Math.abs(t.settings.volumeRatio-r)<1e-9)?.result.qhaSha256))||
  !Number.isInteger(saved.selection.qIndex)||!Number.isInteger(saved.selection.modeIndex)||
  !value.samples[saved.selection.qIndex]?.modes[saved.selection.modeIndex])throw Error('Saved Grüneisen result does not match this phonon path and volume triplet.');
}
function restore(saved){
 result=saved.result;resultHash=saved.sha256;volumeRecord={result,sha256:resultHash};selection=saved.selection;
 $('gruneisen-step').value=Number(((result.volumeRatios[2]-1)*100).toFixed(8));
 controls();present();$('phonon-gruneisen-panel').open=true;
 $('qha-gruneisen-status').textContent='Saved path Grüneisen reopened · no force evaluations';
}

function standaloneFields(){
 return dedicatedProject&&owner?{volumeGruneisenWorkflow:{schema:'macer-volume-gruneisen-workflow-v1',configurationHash:owner.configurationHash,volumes:dedicatedProject,...projectFields(true)}}:{};
}
async function validateStandalone(source){
 const saved=source.volumeGruneisenWorkflow;if(!saved)return null;
 if(saved.schema!=='macer-volume-gruneisen-workflow-v1'||saved.configurationHash!==source.configurationHash)throw Error('Volume Grüneisen workflow does not match the phonon source.');
 const volumes=await root.CalculationProject.verifyTaskIdentities(saved.volumes);
 if(volumes.model.modelKey!==source.modelKey||volumes.tasks.length!==3||!volumes.tasks.every(t=>t.type==='qha-volume'&&t.status==='completed'&&!t.settings.nac))throw Error('Volume Grüneisen requires three completed no-NAC volumes for the saved model.');
 if(saved.gruneisen)await validateSaved(saved.gruneisen,source,volumes);
 return {...saved,volumes};
}
function restoreStandalone(saved){
 dedicatedProject=saved.volumes;project=dedicatedProject;root.PhononGruneisenBz?.setSource(owner,project);
 $('gruneisen-step').value=Number(((project.tasks.at(-1).settings.volumeRatio-1)*100).toFixed(8));
 if(saved.gruneisen)restore(saved.gruneisen);else controls();
}
function invalidateDirectional(id){if(result?.analysis?.id!==id)return;result=null;resultHash=null;branchOrders=[];$('gruneisen-result').hidden=true;root.PhononBand.setGruneisen(null);root.PhononBand.setSelectedModeOverride(null);}
function displayDirectional(value,hash){result=value;resultHash=hash;const selected=root.PhononBand.getViewSettings?.();if(selected){selection={qIndex:selected.qIndex??selection.qIndex,modeIndex:selected.modeIndex??selection.modeIndex};}present();}
$('gruneisen-q-range').oninput=()=>{const v=$('gruneisen-q-range').valueAsNumber;$('gruneisen-q-range').setCustomValidity(Number.isFinite(v)&&v>0?'':'Enter a positive axis limit.');if(result&&v>0){cancelGammaDrag();gammaViewport=null;showSelection();plotControls();}};
$('gruneisen-q-full-range').onclick=()=>{$('gruneisen-q-range').value='';$('gruneisen-q-range').setCustomValidity('');resetGammaZoom();};
$('phonon-gamma-limit').addEventListener('input',()=>{if(result)showSelection();});
document.addEventListener('macer-gruneisen-color',({detail})=>{
 if(detail.key==='gruneisen'&&volumeRecord){result=volumeRecord.result;resultHash=volumeRecord.sha256;present();}
});
root.PhononGruneisenUi={setSource,setBusy:value=>{busy=value;root.PhononGruneisenBz?.setBusy(value);controls();root.PhononDirectionalUi?.setBusy(value);},projectFields,validateSaved,restore,standaloneFields,validateStandalone,restoreStandalone,displayDirectional,invalidateDirectional,refreshVolumeOption:()=>{$('phonon-band-color').querySelector('[value=gruneisen]').disabled=!volumeRecord;},getSelection:()=>({...selection})};
})(globalThis);
