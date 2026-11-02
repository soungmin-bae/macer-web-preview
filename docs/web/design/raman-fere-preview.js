/* Opt-in, client-only response on existing Gamma phonons. Does not change forces. */
(function(root){'use strict';const $=id=>document.getElementById(id),P=root.RamanParameters,C=root.RamanCore;
const zone=$('bz-canvas')?.closest('.bz-viewer')?.parentElement;if(!zone||!root.PhononBand)return;
const bz=document.createElement('div');while(zone.firstChild)bz.append(zone.firstChild);zone.append(bz);
const tabs=document.createElement('div');tabs.className='phonon-toolbar raman-tabs';tabs.innerHTML='<button type="button" id="raman-show-bz" aria-pressed="true">Brillouin zone</button><button type="button" id="raman-show-spectrum" aria-pressed="false">Estimated Raman</button>';zone.prepend(tabs);
const panel=document.createElement('section');panel.id='raman-panel';panel.className='raman-panel';panel.hidden=true;panel.setAttribute('aria-label','Estimated Raman');panel.innerHTML=`<h3>ESTIMATED RAMAN</h3><p class="raman-caption">RamanDB-fitted bond-polarizability tensors · approximate relative spectrum</p><div class="phonon-toolbar"><label id="raman-model-label">Model <select id="raman-model" aria-label="Raman response model" disabled><option value="fere">RamanDB-fitted bond-polarizability</option></select></label><button type="button" class="primary" id="raman-calculate" disabled>Calculate Raman</button><button type="button" id="raman-stop" disabled>Stop</button><button type="button" id="raman-resume" hidden>Resume</button><label>FWHM [cm⁻¹] <input id="raman-width" type="number" min="0.1" max="200" step="1" value="15"></label></div><label id="raman-confirm-label" hidden><input id="raman-confirm" type="checkbox"> This file contains analytic Γ modes, without directional NAC.</label><p id="raman-status" role="status">Open or calculate phonons first.</p><canvas id="raman-plot" aria-label="Estimated Raman spectrum. Click a peak to select its Gamma mode." tabindex="0"></canvas><label class="raman-mode-label">Γ mode · cm⁻¹ · activity [a.u.]<select id="raman-mode" aria-label="Gamma Raman mode" size="4"></select></label><div class="phonon-toolbar"><button type="button" id="raman-prev" disabled>Previous mode</button><button type="button" id="raman-next" disabled>Next mode</button><button type="button" id="raman-view" disabled>View vibration</button></div><p id="raman-selection" aria-live="polite"></p><details><summary>Model basis &amp; exports</summary><p>FERE predicts a symmetric mode Raman tensor by differentiating a bond-polarizability model fitted to RamanDB tensors. The frozen RamanDB check passed on 98 scoreable structures (cosine median 0.898; major-peak recall 0.854). This is an approximate relative preview: absolute cross sections, resonance, temperature and anharmonic effects are not included, and individual materials can differ.</p><p>This predicts an approximate relative powder spectrum from differentiated mode Raman tensors. Absolute cross sections, resonance, temperature and anharmonic effects are not included. Individual materials can differ.</p><div class="phonon-toolbar"><button type="button" id="raman-json" disabled>Response JSON</button><button type="button" id="raman-modes-csv" disabled>Modes CSV</button><button type="button" id="raman-spectrum-csv" disabled>Spectrum CSV</button><button type="button" id="raman-parameters">Parameters JSON</button><button type="button" id="raman-svg" disabled>Plot SVG</button></div></details>`;zone.append(panel);
root.SpectrumView.mount(panel);
let data=null,gamma=-1,revision=0,worker=null,workerKind=null,workerCacheHash=null,job=null,rows=[],identity=null,prepared=null,state='idle',lastSelection={qIndex:0,modeIndex:0},plot=null,drawRequest=0,elapsed=0,started=0,widthError=false;
const isDFT=()=>$('raman-model').value==='dft',isFERE=()=>$('raman-model').value==='fere',manifest=()=>isDFT()?root.RamanDFTRuntime:isFERE()?root.RamanFEREBundle:P.manifest;
function methodDescription(){return isFERE()?'RamanDB-fitted FERE bond-polarizability tensor · approximate relative powder spectrum':isDFT()?'DFT-trained relative powder profile · experimental · no single tensor':'Geometric BPM · unfitted coefficients · relative activity';}
function runtimeIdentity(method=$('raman-model').value){return method==='fere'?{responseRuntime:'fere-v1',candidateId:root.RamanFEREBundle.candidateId,candidateSHA256:root.RamanFEREBundle.candidateSHA256,kernel:root.RamanFEREBundle.kernel,kernelSHA256:root.RamanFEREBundle.kernelSHA256,workerSHA256:root.RamanFEREBundle.workerSHA256,runtime:root.RamanRuntime||null}:root.RamanRuntime||null;}
$('raman-model').onchange=()=>{if(job)return;rows=[];identity=null;prepared=null;state='idle';modeOptions();root.SpectrumView.clear($('raman-plot'),'Calculate Raman with the selected model.');panel.querySelector('.raman-caption').textContent=methodDescription();status(isFERE()?'Ready to calculate a RamanDB-fitted approximate mode tensor.':isDFT()?'Experimental relative intensities only; there is no single Raman tensor.':'Ready to estimate geometric BPM.');controls();document.dispatchEvent(new CustomEvent('macer-raman-method-change'));};
const status=text=>$('raman-status').textContent=text;
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');
function download(name,body,type='application/json'){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([body],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function toggle(raman){panel.hidden=!raman;bz.hidden=raman;$('raman-show-bz').setAttribute('aria-pressed',String(!raman));$('raman-show-spectrum').setAttribute('aria-pressed',String(raman));if(raman)draw();else root.PhononBand.refresh?.();}
$('raman-show-bz').onclick=()=>toggle(false);$('raman-show-spectrum').onclick=()=>toggle(true);
function readiness(){
 if(!data)return 'Open or calculate phonons first.';
 if(data.nac)return 'Directional NAC modes cannot be used here. Provide analytic Γ modes without NAC.';
 if(!data.hasEigenvectors)return 'Complete eigenvectors are required for Raman.';
 if(data.atoms.some(a=>!Number.isFinite(a.mass)||a.mass<=0))return 'Positive atom masses are required for Raman.';
 if(gamma<0)return 'No q=(0,0,0) point is present in these bands.';
 if(!Object.hasOwn(data,'nac')&&!$('raman-confirm').checked)return 'Confirm analytic Γ for this imported file.';
 return null;
}
function controls(){const busy=!!job;$('raman-model').disabled=busy;$('raman-calculate').disabled=busy||!!readiness();$('raman-stop').disabled=!busy;$('raman-resume').hidden=busy||!rows.length||rows.length===data?.qpoints[gamma]?.bands.length;$('raman-resume').disabled=!!readiness();const width=Number($('raman-width').value),validWidth=Number.isFinite(width)&&width>0&&width<=200;for(const id of ['raman-json','raman-spectrum-csv','raman-svg'])$(id).disabled=!rows.length||!validWidth;$('raman-modes-csv').disabled=!rows.length;for(const id of ['raman-prev','raman-next','raman-view'])$(id).disabled=gamma<0;}
function selectedGamma(){return data&&lastSelection.qIndex===gamma;}
function refreshSelection(){
 if(!data||gamma<0)return;
 $('raman-mode').value=selectedGamma()?String(lastSelection.modeIndex):'';
 const mode=rows.find(m=>m.modeIndex===lastSelection.modeIndex);
 $('raman-selection').textContent=selectedGamma()?`Mode ${lastSelection.modeIndex+1} · ${(data.qpoints[gamma].bands[lastSelection.modeIndex].frequencyTHz*1e12/(299792458*100)).toFixed(3)} cm⁻¹${mode?' · activity '+mode.activity.toExponential(4)+' · '+mode.status:' · response pending'}`:'Viewer is outside Γ. Select a Raman mode to return to Γ.';
 scheduleDraw();
}
function selectMode(index){if(!data||gamma<0)return;root.PhononBand.select(gamma,Math.max(0,Math.min(data.qpoints[gamma].bands.length-1,index)));}
$('raman-mode').onchange=()=>selectMode(Number($('raman-mode').value));$('raman-prev').onclick=()=>selectMode(lastSelection.modeIndex-1);$('raman-next').onclick=()=>selectMode(lastSelection.modeIndex+1);$('raman-view').onclick=()=>{selectMode(lastSelection.modeIndex);$('phonon-crystal').scrollIntoView({block:'center',behavior:'smooth'});};
function modeOptions(){const list=$('raman-mode');list.replaceChildren();if(!data||gamma<0)return;data.qpoints[gamma].bands.forEach((b,i)=>list.add(new Option(`${i+1} · ${(b.frequencyTHz*1e12/(299792458*100)).toFixed(3)} · pending`,String(i))));}
function load(value){stop(false);revision++;data=value;gamma=value.qpoints.findIndex(q=>q.q.every(x=>Math.abs(x)<1e-8));rows=[];identity=null;prepared=null;elapsed=0;state='idle';root.SpectrumView.clear($('raman-plot'),'Calculate Raman for the current Gamma result.');$('raman-confirm').checked=false;$('raman-confirm-label').hidden=Object.hasOwn(value,'nac');modeOptions();refreshSelection();status(readiness()||'Uses existing Γ phonons; no new force evaluations.');controls();scheduleDraw();}
function stop(showStatus=true){const wasRunning=!!job;job=null;worker?.terminate();worker=null;workerKind=null;workerCacheHash=null;if(wasRunning)elapsed+=performance.now()-started;if(showStatus){state='stopped';status(`Stopped · ${rows.length} complete modes preserved.`);}controls();}
async function start(resume=false){
 const error=readiness();if(error){status(error);return;}if(job)return;const requestedWorkerKind=isFERE()?'fere':isDFT()?'dft':'bpm';if(worker&&workerKind!==requestedWorkerKind){worker.terminate();worker=null;workerKind=null;workerCacheHash=null;}if(!resume){rows=[];identity=null;}const currentRevision=revision,jobId=crypto.randomUUID();job={jobId,revision:currentRevision};state='loading';controls();status(isFERE()?'Preparing the RamanDB-fitted bond model…':isDFT()?'Preparing DFT relative profile…':'Preparing geometric BPM…');started=performance.now();
 try{
  const gammaData={lattice:data.lattice,atoms:data.atoms,q:data.qpoints[gamma].q,bands:data.qpoints[gamma].bands,execution:data.execution||data.calculator||null};
  const [phononHash,parameterHash]=await Promise.all([hash(gammaData),hash(manifest())]);if(!job||job.jobId!==jobId||revision!==currentRevision)return;
  if(resume&&identity&&(identity.phononHash!==phononHash||identity.parameterHash!==parameterHash))throw Error('Cannot resume: phonon or parameter identity changed.');
  identity={phononHash,parameterHash,parameterId:manifest().id,kernel:manifest().kernel,runtimeHashes:runtimeIdentity(),candidateId:isFERE()?manifest().candidateId:null,gammaIndex:gamma,origin:Object.hasOwn(data,'nac')?'known-no-NAC':'user-confirmed-analytic-Gamma',execution:data.execution||data.calculator||null};Object.assign(job,{phononHash,parameterHash});
  if(!worker){worker=new Worker(isFERE()?'./raman-fere-worker.js':isDFT()?'./raman-dft-worker.js':'./raman-worker.js');workerKind=requestedWorkerKind;}state='running';
  worker.onmessage=({data:m})=>{if(!job||m.jobId!==job.jobId||m.revision!==revision||m.phononHash!==job.phononHash||m.parameterHash!==job.parameterHash)return;
   if(m.type==='prepared'){prepared={pairs:m.pairCount??m.bondCount,candidates:m.candidates,volume_A3:m.volume,estimatedWorkBytes:m.memoryEstimate,diagnostics:m.diagnostics||null,relativeOnly:!!m.relativeOnly};if(workerKind==='bpm')workerCacheHash=phononHash;}
   else if(m.type==='mode'||m.type==='modes'){
    const completed=m.type==='mode'?[{modeIndex:m.modeIndex,result:m.result}]:m.results;
    if(!Array.isArray(completed)||!completed.length){fail('Invalid Raman mode batch. Completed results preserved.');return;}
    for(const row of completed){if(row.modeIndex!==rows.length){fail('Out-of-order Raman mode. Completed results preserved.');return;}rows.push(row.result);const option=$('raman-mode').options[row.modeIndex];if(option)option.textContent=`${row.modeIndex+1} · ${row.result.frequencyCm.toFixed(3)} · ${row.result.activity.toExponential(3)}`;}
    status(`Raman · ${rows.length} / ${data.qpoints[gamma].bands.length} modes`);controls();refreshSelection();
   }
   else if(m.type==='finished'){elapsed+=performance.now()-started;job=null;worker.onmessage=null;worker.onerror=null;state='completed';status(Math.max(0,...rows.filter(m=>m.frequencyTHz>=.1).map(m=>m.activity))<=P.manifest.activityResolution?'Completed · no resolved Raman activity. Raw activities retained.':`Completed · ${rows.length} Γ modes · ${isFERE()?'RamanDB-fitted tensor-derived relative activity':isDFT()?'experimental relative powder activity':'geometric BPM relative powder activity'}`);controls();scheduleDraw();}
   else if(m.type==='error')fail(m.message);
  };
  worker.onerror=()=>fail('Raman Worker failed. Completed phonons and response modes are preserved.');
  const reuseCached=workerKind==='bpm'&&workerCacheHash===phononHash;const request={...job,q:data.qpoints[gamma].q,nacEnabled:false,parameterId:manifest().id,startIndex:rows.length,reuseCached};if(!reuseCached){request.data={lattice:data.lattice,atoms:data.atoms};request.bands=data.qpoints[gamma].bands;}worker.postMessage(request);
 }catch(error){if(job?.jobId===jobId)fail(error.message);}
}
function fail(message){stop(false);state='failed';status(message);controls();scheduleDraw();}
$('raman-calculate').onclick=()=>start(false);$('raman-resume').onclick=()=>start(true);$('raman-stop').onclick=()=>stop(true);$('raman-confirm').onchange=()=>{status(readiness()||'Ready to estimate Raman from the confirmed analytic Γ modes.');controls();};
function scheduleDraw(){if(!drawRequest)drawRequest=requestAnimationFrame(()=>{drawRequest=0;draw();});}
function drawingData(){const width=Number($('raman-width').value);return root.SpectrumView.spectrum(rows);}
function draw(){
 if(!rows.length)return;
 try{const samples=drawingData();plot=root.SpectrumView.draw($('raman-plot'),samples,{label:'Estimated Raman spectrum',sticks:rows,selectedFrequency:selectedGamma()?data.qpoints[gamma].bands[lastSelection.modeIndex].frequencyTHz*1e12/(299792458*100):null});$('raman-width').setCustomValidity('');if(widthError){widthError=false;status(`${state} · ${rows.length} complete modes`);}}
 catch(error){widthError=true;status(error.message);}
}
$('raman-width').oninput=()=>{controls();scheduleDraw();};
$('raman-plot').onclick=event=>{if(!plot||!rows.length)return;const rect=$('raman-plot').getBoundingClientRect(),frequency=root.SpectrumView.at(event,plot),active=rows.filter(m=>m.frequencyTHz>=.1&&m.activity>P.manifest.activityResolution);if(!active.length)return;let nearest=active.reduce((a,b)=>Math.abs(b.frequencyCm-frequency)<Math.abs(a.frequencyCm-frequency)?b:a);const current=active.find(m=>m.modeIndex===lastSelection.modeIndex);if(selectedGamma()&&current&&Math.abs(current.frequencyCm-frequency)<=Math.abs(nearest.frequencyCm-frequency)+1e-4)nearest=current;selectMode(nearest.modeIndex);};
$('raman-plot').onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();selectMode(lastSelection.modeIndex+(e.key==='ArrowRight'?1:-1));}};
function fields(){return {schema:isFERE()?'macer-raman-response-v3':isDFT()?'macer-raman-response-v2':'macer-raman-response-v1',identity,model:manifest().id,parameters:manifest(),absoluteIntensityAvailable:false,singleRamanTensorAvailable:!isDFT(),activityKind:isFERE()?'powder-activity-from-fitted-mode-tensor':isDFT()?'relative-profile':'bpm-arbitrary-units',geometry:data?{lattice:data.lattice,atoms:data.atoms}:null,prepared,state,complete:state==='completed',elapsed_ms:elapsed,modes:rows,display:{...root.SpectrumView.settings(),normalization:'full-result maximum 100; changing view range does not renormalize; below-resolution noise not amplified',positive_cutoff_THz:.1,activity_resolution:P.manifest.activityResolution},spectrum:rows.length?drawingData():[]};}
$('raman-json').onclick=()=>download('estimated-raman.json',JSON.stringify(fields(),null,2));$('raman-parameters').onclick=()=>download('raman-parameters.json',JSON.stringify(manifest(),null,2));
$('raman-modes-csv').onclick=()=>{const header=['mode','frequency_THz','frequency_cm-1','activity_au','activity_per_A3','status','deltaQ_A_sqrt_amu','fd_error',...['re','im'].flatMap(p=>Array.from({length:9},(_,i)=>p+'_'+i))];download('raman-modes.csv',header.join(',')+'\n'+rows.map(m=>[m.modeIndex+1,m.frequencyTHz,m.frequencyCm,m.activity,m.activityPerVolume,m.status,m.deltaQ_A_sqrt_amu,m.fdError,...(m.tensorReal||Array(9).fill('')),...(m.tensorImag||Array(9).fill(''))].join(',')).join('\n'),'text/csv');};
$('raman-spectrum-csv').onclick=()=>download('raman-spectrum.csv','frequency_cm-1,raw_activity_density,relative_activity_density\n'+drawingData().map(r=>r.join(',')).join('\n'),'text/csv');
$('raman-svg').onclick=()=>download('estimated-raman.svg',root.SpectrumView.svg(drawingData(),'Estimated Raman · '+methodDescription()+'; full-result normalization'),'image/svg+xml');
document.addEventListener('macer-spectrum-view-change',scheduleDraw);
document.addEventListener('macer-phonon-clear',()=>{stop(false);revision++;data=null;gamma=-1;rows=[];identity=null;prepared=null;elapsed=0;state='idle';modeOptions();controls();toggle(false);root.SpectrumView.setFrequencies([]);status('Open or calculate phonons first.');});
document.addEventListener('macer-phonon-result',e=>load(e.detail.data));document.addEventListener('macer-phonon-selection',e=>{lastSelection=e.detail;refreshSelection();});root.addEventListener('resize',scheduleDraw);if(root.PhononBand.getData())load(root.PhononBand.getData());controls();
root.addEventListener('pagehide',()=>{worker?.terminate();worker=null;workerKind=null;workerCacheHash=null;});
const example=document.createElement('button');example.id='raman-si-example';example.type='button';example.textContent='Try a calculated Si Γ Raman example';
$('phonon-results-empty').append(example);
example.onclick=async()=>{
 example.disabled=true;
 try{
  const response=await fetch('./examples/raman-si-nep.json',{credentials:'omit'});if(!response.ok)throw Error('Could not load the saved Si example.');const bytes=await response.arrayBuffer();
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');if(!root.RamanRuntime?.exampleSHA256||digest!==root.RamanRuntime.exampleSHA256)throw Error('Si example hash mismatch.');
  const saved=JSON.parse(new TextDecoder().decode(bytes));root.PhononBand.loadResult(saved.result,'Saved Si example · actual NEP phonons',{repeats:[2,2,2]});toggle(true);const first=data.qpoints[gamma].bands.findIndex(b=>b.frequencyTHz>=.1);if(first>=0)selectMode(first);await start(false);
 }catch(error){status(error.message);toggle(true);}
 finally{example.disabled=false;}
};
function projectState(){return {method:$('raman-model').value,visible:!panel.hidden,confirmedAnalytic:$('raman-confirm').checked,response:identity&&rows.length?fields():null,display:root.SpectrumView.settings()};}
async function restoreProject(saved){
 if(!saved)return;
 stop(false);const rev=revision;
 if(!['bpm','dft','fere'].includes(saved.method))throw Error('Unknown saved Raman model.');
 const response=saved.response,parameters=saved.method==='dft'?root.RamanDFTRuntime:saved.method==='fere'?root.RamanFEREBundle:P.manifest;
 if(response){
  if(!data||gamma<0||data.nac)throw Error('Saved Raman response requires matching analytic Gamma modes.');
  const gammaData={lattice:data.lattice,atoms:data.atoms,q:data.qpoints[gamma].q,bands:data.qpoints[gamma].bands,execution:data.execution||data.calculator||null};
  const [phononHash,parameterHash]=await Promise.all([hash(gammaData),hash(parameters)]);
  if(rev!==revision)throw Error('Phonons changed while restoring Raman.');
  if(response.identity?.phononHash!==phononHash||response.identity?.parameterHash!==parameterHash||response.identity?.kernel!==parameters.kernel||response.identity?.candidateId!==(saved.method==='fere'?parameters.candidateId:null)||!root.PhononProject.sameResponseRuntime(response.identity?.runtimeHashes,runtimeIdentity(saved.method)))throw Error('Saved Raman structure, modes, parameters or calculation runtime identity does not match.');
  const bands=data.qpoints[gamma].bands;
  if(!Array.isArray(response.modes)||response.modes.length>bands.length||response.complete&&response.modes.length!==bands.length||response.modes.some((m,i)=>m.modeIndex!==i||m.frequencyTHz!==bands[i].frequencyTHz||!Number.isFinite(m.activity)||m.activity<0||!Number.isFinite(m.frequencyCm)))throw Error('Invalid saved Raman mode results.');
 }
 $('raman-model').value=saved.method;$('raman-confirm').checked=!!saved.confirmedAnalytic;
 rows=response?JSON.parse(JSON.stringify(response.modes)):[];identity=response?.identity||null;prepared=response?.prepared||null;elapsed=response?.elapsed_ms||0;state=response?(response.complete?'completed':'stopped'):'idle';
 modeOptions();root.SpectrumView.restore(saved.display);toggle(!!saved.visible);refreshSelection();controls();
 status(response?`Restored Raman · ${rows.length} complete Γ modes · ${state}`:'Uses existing Γ phonons; no new force evaluations.');
}
root.RamanPreview=Object.freeze({getResponse:fields,methodDescription,projectState,restoreProject});
})(globalThis);
