/* Opt-in, client-only response on existing Gamma phonons. Does not change forces. */
(function(root){'use strict';const $=id=>document.getElementById(id),P=root.RamanParameters,C=root.RamanCore;
const zone=$('bz-canvas')?.closest('.bz-viewer')?.parentElement;
const previewScriptURL=document.currentScript?.src||'./raman-preview.js';
const cgcnnRuntimeAssetVersion=()=>{const script=[...document.scripts].find(entry=>new URL(entry.src,location.href).pathname.endsWith('/cgcnn-response-runtime.js'));return script?new URL(script.src,location.href).searchParams.get('v')||'dev':'dev';};
if(!zone||!root.PhononBand){
 const empty=$('phonon-results-empty');
 let example=$('raman-si-example');
 if(!example){example=document.createElement('button');example.id='raman-si-example';example.type='button';example.textContent='Try calculated Si Raman · NEP';empty?.append(example);}
 let note=$('raman-si-example-status');
 if(!note){note=document.createElement('p');note.id='raman-si-example-status';note.setAttribute('role','status');example.after(note);}
 const boot=()=>{
  if(root.__macerRamanPreviewInitialized||root.__macerRamanPreviewBootPending)return;
  root.__macerRamanPreviewBootPending=true;
  const script=document.createElement('script'),url=new URL(previewScriptURL,location.href);
  url.searchParams.set('_raman_boot',String(Date.now()));script.src=url.href;
  script.onload=()=>{delete root.__macerRamanPreviewBootPending;};
  script.onerror=()=>{delete root.__macerRamanPreviewBootPending;note.textContent='Could not initialize Raman preview. Reload the page and try again.';};
  document.body.append(script);
 };
 document.addEventListener('macer-phonon-result',boot,{once:true});
 example.onclick=async()=>{
  example.disabled=true;note.textContent='Loading the saved Si Γ phonon result…';
  try{
   const response=await fetch('./examples/raman-si-nep.json?v=fd82cba2eb58c9fd',{credentials:'omit'});if(!response.ok)throw Error('Could not load the saved Si example.');const bytes=await response.arrayBuffer();
   const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');if(!root.RamanRuntime?.exampleSHA256||digest!==root.RamanRuntime.exampleSHA256)throw Error('Si example hash mismatch.');
   const saved=JSON.parse(new TextDecoder().decode(bytes));root.__macerRamanPreviewExamplePending=true;root.PhononBand.loadResult(saved.result,'Saved Si example · actual NEP phonons');
  }catch(error){note.textContent=error.message;example.disabled=false;}
 };
 return;
}
if(root.__macerRamanPreviewInitialized)return;root.__macerRamanPreviewInitialized=true;
const bz=document.createElement('div');while(zone.firstChild)bz.append(zone.firstChild);zone.append(bz);
const tabs=document.createElement('div');tabs.className='phonon-toolbar raman-tabs';tabs.innerHTML='<button type="button" id="raman-show-bz" aria-pressed="true">Brillouin zone</button><button type="button" id="raman-show-spectrum" aria-pressed="false">Estimated Raman</button>';zone.prepend(tabs);
const panel=document.createElement('section');panel.id='raman-panel';panel.className='raman-panel';panel.hidden=true;panel.setAttribute('aria-label','Raman spectrum estimate');panel.innerHTML=`<h3>RAMAN SPECTRUM</h3><p class="raman-caption">Select a response model to see how its estimate is formed.</p><div class="phonon-toolbar"><label id="raman-model-label">Response model <select id="raman-model"><option value="cgcnn" selected>CGCNN</option><option value="dft">Channel mixture</option><optgroup label="Bond-polarizability models"><option value="fere">Fitted BPM</option><option value="fere-r4">Environment BPM</option><option value="bpm">Fixed BPM</option></optgroup></select></label><button type="button" class="primary" id="raman-calculate" disabled>Calculate Raman</button><button type="button" id="raman-stop" disabled>Stop</button><button type="button" id="raman-resume" hidden>Resume</button><label>FWHM [cm⁻¹] <input id="raman-width" type="number" min="0.1" max="200" step="1" value="10"></label></div><label id="raman-confirm-label" hidden><input id="raman-confirm" type="checkbox"> This file contains analytic Γ modes, without directional NAC.</label><p id="raman-status" role="status">Open or calculate phonons first.</p><details id="raman-coverage" class="raman-coverage" hidden><summary id="raman-coverage-summary">Bond-coefficient coverage</summary><p id="raman-coverage-details"></p><p class="raman-coverage-note">Coverage shows which fitted corrections were available; it is not a measure of accuracy.</p></details><canvas id="raman-plot" aria-label="Estimated Raman spectrum. Click a peak to select its Gamma mode." tabindex="0"></canvas><label class="raman-mode-label">Γ mode · cm⁻¹ · relative activity [a.u.]<select id="raman-mode" aria-label="Gamma Raman mode" size="4"></select></label><div class="phonon-toolbar"><button type="button" id="raman-prev" disabled>Previous mode</button><button type="button" id="raman-next" disabled>Next mode</button><button type="button" id="raman-view" disabled>View vibration</button></div><p id="raman-selection" aria-live="polite"></p><details><summary>About this model</summary><p id="raman-model-basis"></p><div class="phonon-toolbar"><button type="button" id="raman-json" disabled>Response JSON</button><button type="button" id="raman-modes-csv" disabled>Modes CSV</button><button type="button" id="raman-spectrum-csv" disabled>Spectrum CSV</button><button type="button" id="raman-parameters">Parameters JSON</button><button type="button" id="raman-svg" disabled>Plot SVG</button></div></details>`;zone.append(panel);

const emptySpectrum=document.createElement('p');emptySpectrum.id='raman-empty-spectrum';emptySpectrum.className='raman-empty-spectrum';emptySpectrum.textContent='Mode frequencies and vibrations are ready. Calculate Raman to see peak strengths and the spectrum.';$('raman-plot').before(emptySpectrum);
root.SpectrumView.mount(panel);
let data=null,gamma=-1,revision=0,worker=null,workerKind=null,workerCacheHash=null,job=null,rows=[],identity=null,prepared=null,state='idle',lastSelection={qIndex:0,modeIndex:0},plot=null,drawRequest=0,elapsed=0,started=0,widthError=false,previousComplete=null;
const isCGCNN=()=>$('raman-model').value==='cgcnn',isDFT=()=>$('raman-model').value==='dft',isFERE=()=>$('raman-model').value==='fere',isFERE4=()=>$('raman-model').value==='fere-r4',isAnyFERE=()=>isFERE()||isFERE4(),manifest=()=>isCGCNN()?root.CgcnnRamanRuntime:isDFT()?root.RamanDFTRuntime:isFERE4()?root.RamanFEREPreviewBundle:isFERE()?root.RamanFEREBundle:P.manifest;
function methodLabel(){return $('raman-model').selectedOptions[0]?.textContent||'Raman';}
function methodDescription(){return isCGCNN()?'Neural-network polarizability model trained on RamanDB data.':isFERE4()?'Bond polarizability fitted to RamanDB tensors, with local-environment corrections.':isFERE()?'Bond coefficients fitted to RamanDB tensors.':isDFT()?'Response-channel mixture trained on RamanDB data for relative Raman intensities.':'Bond polarizability with fixed, unfitted coefficients.';}
function methodSummary(){return isCGCNN()?'A graph neural network predicts polarizability; its derivatives give the Raman tensors.':isFERE4()?'A fitted bond-polarizability model with corrections for the surrounding atomic environment.':isFERE()?'A bond-polarizability model with coefficients fitted to RamanDB tensors.':isDFT()?'Combines learned response channels to estimate relative Raman peak strengths; no single Raman tensor.':'A bond-polarizability estimate using fixed, unfitted coefficients.';}
function phononSourceLabel(){const e=data?.execution||{},name=e.modelKey||e.modelId;return name?`${name}${e.runtimeBackend?` / ${e.runtimeBackend}`:''}`:'imported; model not recorded';}
function phononSourceDescription(){const e=data?.execution||{},name=e.modelKey||e.modelId;if(name)return `Phonon modes calculated with ${name}${e.runtimeBackend?` (${e.runtimeBackend})`:''}.`;return 'The imported phonon file does not record which force model produced these modes.';}
function updateModelBasis(){const basis=$('raman-model-basis');if(!basis)return;const text=methodDescription(),at=text.indexOf('RamanDB');basis.replaceChildren();if(at<0){basis.textContent=text;return;}const source=document.createElement('a');source.href='https://ramandb.oulu.fi/';source.target='_blank';source.rel='noopener noreferrer';source.textContent='RamanDB';source.title='Computational Raman Database · University of Oulu';basis.append(text.slice(0,at),source,text.slice(at+7));}
panel.querySelector('.raman-caption').textContent=methodLabel();updateModelBasis();
function notifyResponseChange(){document.dispatchEvent(new Event('macer-raman-response-change'));}
function runtimeIdentity(method=$('raman-model').value){if(method==='cgcnn')return {responseRuntime:root.CgcnnRamanRuntime.id,checkpointSHA256:root.CgcnnRamanRuntime.checkpointSHA256,bundleSHA256:root.CgcnnRamanRuntime.bundleSHA256,wasmSHA256:root.CgcnnRamanRuntime.wasmSHA256,workerSHA256:root.CgcnnRamanRuntime.workerSHA256,runtime:root.CgcnnRamanRuntime};if(method==='fere-r4')return {responseRuntime:'fere-r4-experimental-v1',candidateId:root.RamanFEREPreviewBundle.candidateId,candidateSHA256:root.RamanFEREPreviewBundle.candidateSHA256,kernel:root.RamanFEREPreviewBundle.kernel,bundleSHA256:root.RamanRuntime?.fereR4BundleSHA256||null,runtime:root.RamanRuntime||null};return method==='fere'?{responseRuntime:'fere-rust-wasm-v1',candidateId:root.RamanFEREBundle.candidateId,candidateSHA256:root.RamanFEREBundle.candidateSHA256,kernel:'fere-periodic-bond-analytic-rust-f64-v1',wasmSHA256:'d7611e3aec7b5e0e7f96e47eb084ae26bc7a4570ca951fa82a8b958aab05a1fe',runtime:root.RamanRuntime||null}:root.RamanRuntime||null;}
$('raman-model').onchange=()=>{if(job)return;rows=[];identity=null;prepared=null;state='idle';renderCoverage(null);modeOptions();root.SpectrumView.clear($('raman-plot'),'Calculate Raman with the selected model.');panel.querySelector('.raman-caption').textContent=methodLabel();updateModelBasis();status('Ready to calculate using the selected response model.');controls();document.dispatchEvent(new CustomEvent('macer-raman-method-change'));};
const status=text=>$('raman-status').textContent=text;
function renderCoverage(diagnostics){
 const box=$('raman-coverage');
 if(!box||!isFERE()||!diagnostics){if(box)box.hidden=true;return;}
 const pct=value=>`${Math.round(Math.max(0,Math.min(1,Number(value)||0))*100)}%`;
 const endpoint=pct(diagnostics.fittedBondEndpointFraction),pair=pct(diagnostics.fittedPairBondFraction);
 $('raman-coverage-summary').textContent=`Coefficient coverage · element ${endpoint} · pair ${pair}`;
 const symbol=z=>Object.entries(root.ElementStyles||{}).find(([,row])=>row.atomic_number===z)?.[0]||`Z=${z}`;
 const globalOnly=(diagnostics.globalOnlyAtomicNumbers||[]).map(symbol);
 const unmatched=(diagnostics.unmatchedBondPairLabels||[]);
 const lines=[`Fitted element corrections cover ${endpoint} of bond endpoints.`,`Fitted pair corrections cover ${pair} of periodic bonds.`];
 lines.push(globalOnly.length?`Global-only elements: ${globalOnly.join(', ')}.`:'No global-only elements in this structure.');
 if(unmatched.length)lines.push(`Pairs without fitted pair corrections: ${unmatched.slice(0,6).join(', ')}${unmatched.length>6?`, and ${unmatched.length-6} more`:''}.`);
 $('raman-coverage-details').textContent=lines.join(' ');
 box.hidden=false;
 box.open=globalOnly.length>0||unmatched.length>0;
}
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
function controls(){const busy=!!job;emptySpectrum.hidden=!!rows.length||panel.classList.contains('showing-ir');$('raman-plot').hidden=!rows.length||panel.classList.contains('showing-ir');$('raman-model').disabled=busy;$('raman-calculate').disabled=busy||!!readiness();$('raman-stop').disabled=!busy;$('raman-stop').hidden=!busy;$('raman-resume').hidden=busy||!rows.length||rows.length===data?.qpoints[gamma]?.bands.length;$('raman-resume').disabled=!!readiness();const width=Number($('raman-width').value),validWidth=Number.isFinite(width)&&width>0&&width<=200;for(const id of ['raman-json','raman-spectrum-csv','raman-svg'])$(id).disabled=!rows.length||!validWidth;$('raman-modes-csv').disabled=!rows.length;for(const id of ['raman-prev','raman-next','raman-view'])$(id).disabled=gamma<0;}
function selectedGamma(){return data&&lastSelection.qIndex===gamma;}
function refreshSelection(){
 if(!data||gamma<0)return;
 $('raman-mode').value=selectedGamma()?String(lastSelection.modeIndex):'';
 const mode=rows.find(m=>m.modeIndex===lastSelection.modeIndex);
 $('raman-selection').textContent=selectedGamma()?`Mode ${lastSelection.modeIndex+1} · ${(data.qpoints[gamma].bands[lastSelection.modeIndex].frequencyTHz*1e12/(299792458*100)).toFixed(3)} cm⁻¹${mode?' · activity '+mode.activity.toExponential(4)+' · '+mode.status:' · intensity not calculated'}`:'Viewer is outside Γ. Select a Raman mode to return to Γ.';
 scheduleDraw();
}
function selectMode(index){if(!data||gamma<0)return;const mode=Math.max(0,Math.min(data.qpoints[gamma].bands.length-1,index));if(root.PhononBand.selectAnalyticGamma?.(mode))return;root.PhononBand.select(gamma,mode);}
$('raman-mode').onchange=()=>selectMode(Number($('raman-mode').value));$('raman-prev').onclick=()=>selectMode(lastSelection.modeIndex-1);$('raman-next').onclick=()=>selectMode(lastSelection.modeIndex+1);$('raman-view').onclick=()=>{selectMode(lastSelection.modeIndex);$('phonon-crystal').scrollIntoView({block:'center',behavior:'smooth'});};
function modeOptions(){const list=$('raman-mode');list.replaceChildren();if(!data||gamma<0)return;data.qpoints[gamma].bands.forEach((b,i)=>list.add(new Option(`${i+1} · ${(b.frequencyTHz*1e12/(299792458*100)).toFixed(3)} · pending`,String(i))));}
function load(value){stop(false);revision++;data=value;if(value.nac&&value.analyticGamma){const qpoints=value.qpoints.slice(),gi=qpoints.findIndex(q=>q.q.every(x=>Math.abs(x)<1e-8));if(gi>=0)qpoints[gi]={...qpoints[gi],bands:value.analyticGamma.bands,nacDirection:undefined};data={...value,qpoints,nac:null,nacBand:value.nac,analyticGammaSource:value.analyticGamma.source};}updateModelBasis();gamma=data.qpoints.findIndex(q=>q.q.every(x=>Math.abs(x)<1e-8));rows=[];identity=null;prepared=null;renderCoverage(null);elapsed=0;state='idle';root.SpectrumView.clear($('raman-plot'),'Calculate Raman for the current Gamma result.');$('raman-confirm').checked=false;$('raman-confirm-label').hidden=Object.hasOwn(value,'nac');modeOptions();refreshSelection();status(readiness()||'Uses analytic Γ modes; no new force evaluations.');controls();scheduleDraw();}
function stop(showStatus=true){const wasRunning=!!job;job=null;worker?.terminate();worker=null;workerKind=null;workerCacheHash=null;if(wasRunning)elapsed+=performance.now()-started;const retainedPrevious=wasRunning&&!!previousComplete;if(retainedPrevious){rows=previousComplete.rows;identity=previousComplete.identity;prepared=previousComplete.prepared;elapsed=previousComplete.elapsed;}previousComplete=null;if(showStatus){state='stopped';status(retainedPrevious?'Stopped · previous complete Raman result retained.':`Stopped · ${rows.length} complete modes preserved.`);}controls();scheduleDraw();notifyResponseChange();}
async function start(resume=false){
 const error=readiness();if(error){status(error);return;}if(job)return;const requestedWorkerKind=isCGCNN()?'cgcnn':isFERE4()?'fere-r4':isFERE()?'fere':isDFT()?'dft':'bpm';if(worker&&workerKind!==requestedWorkerKind){worker.terminate();worker=null;workerKind=null;workerCacheHash=null;}if(!resume){previousComplete=state==='completed'&&gamma>=0&&rows.length===data?.qpoints[gamma]?.bands.length?{rows:JSON.parse(JSON.stringify(rows)),identity:identity?JSON.parse(JSON.stringify(identity)):null,prepared:prepared?JSON.parse(JSON.stringify(prepared)):null,elapsed}:null;rows=[];identity=null;}const currentRevision=revision,jobId=crypto.randomUUID();job={jobId,revision:currentRevision};state='loading';controls();status(isCGCNN()?'Preparing graph neural network locally…':isFERE4()?'Preparing environment-corrected bond model…':isFERE()?'Preparing the RamanDB-fitted bond model…':isDFT()?'Preparing multichannel relative-intensity model…':'Preparing geometric BPM…');started=performance.now();
 try{
  const gammaData={lattice:data.lattice,atoms:data.atoms,q:data.qpoints[gamma].q,bands:data.qpoints[gamma].bands,execution:data.execution||data.calculator||null};
  const [phononHash,parameterHash]=await Promise.all([hash(gammaData),hash(manifest())]);if(!job||job.jobId!==jobId||revision!==currentRevision)return;
  if(resume&&identity&&(identity.phononHash!==phononHash||identity.parameterHash!==parameterHash))throw Error('Cannot resume: phonon or parameter identity changed.');
  identity={phononHash,parameterHash,parameterId:manifest().id,kernel:manifest().kernel,runtimeHashes:runtimeIdentity(),candidateId:isAnyFERE()?manifest().candidateId:null,gammaIndex:gamma,origin:Object.hasOwn(data,'nac')?'known-no-NAC':'user-confirmed-analytic-Gamma',execution:data.execution||data.calculator||null};Object.assign(job,{phononHash,parameterHash});
   if(!worker){const workerURL=isCGCNN()?`./cgcnn-response-worker.js?v=${encodeURIComponent(root.CgcnnRamanRuntime.workerSHA256)}&runtime=${encodeURIComponent(cgcnnRuntimeAssetVersion())}`:isFERE4()?'./raman-fere-r4-worker.js?v=5289fbf6aa90fe7a':isFERE()?'./raman-fere-worker.js?v=26d5264ac5943e2b':isDFT()?'./raman-dft-worker.js':'./raman-worker.js?v=282c84572269d23d';worker=new Worker(workerURL,isCGCNN()?{type:'module'}:undefined);workerKind=requestedWorkerKind;}state='running';
  worker.onmessage=({data:m})=>{
   if(m.type==='booted'){if(job)status('CGCNN · Worker started');return;}
   if(m.type==='runtime-ready'){if(job)status('CGCNN · local runtime ready');return;}
   if(!job||m.jobId!==job.jobId)return;
   if(m.type==='progress')status(`CGCNN · ${m.stage}`);
   if(m.type==='error'){fail(m.message);return;}
   if(m.revision!==revision||m.phononHash!==job.phononHash||m.parameterHash!==job.parameterHash){fail('CGCNN Worker returned a mismatched input or model identity. Completed phonons are preserved.');return;}
   if(m.type==='prepared'){prepared={pairs:m.pairCount??m.bondCount,candidates:m.candidates,volume_A3:m.volume,estimatedWorkBytes:m.memoryEstimate,diagnostics:m.diagnostics||null,relativeOnly:!!m.relativeOnly,modelId:m.modelId||null};renderCoverage(prepared.diagnostics);if(workerKind==='bpm')workerCacheHash=phononHash;}
   else if(m.type==='progress'){status(`CGCNN · ${m.stage}`);}
   else if(m.type==='mode'||m.type==='modes'){
    const completed=m.type==='mode'?[{modeIndex:m.modeIndex,result:m.result}]:m.results;
    if(!Array.isArray(completed)||!completed.length){fail('Invalid Raman mode batch. Completed results preserved.');return;}
    for(const row of completed){if(row.modeIndex!==rows.length){fail('Out-of-order Raman mode. Completed results preserved.');return;}rows.push(row.result);const option=$('raman-mode').options[row.modeIndex];if(option)option.textContent=`${row.modeIndex+1} · ${row.result.frequencyCm.toFixed(3)} · ${row.result.activity.toExponential(3)}`;}
    status(`Raman · ${rows.length} / ${data.qpoints[gamma].bands.length} modes`);controls();refreshSelection();notifyResponseChange();
   }
   else if(m.type==='finished'){elapsed+=performance.now()-started;previousComplete=null;job=null;worker.onmessage=null;worker.onerror=null;state='completed';status(Math.max(0,...rows.filter(m=>m.frequencyTHz>=.1).map(m=>m.activity))<=P.manifest.activityResolution?'Calculation complete · no resolved Raman-active optical mode; raw activities are retained.':`Calculation complete · ${rows.length} Γ modes evaluated with the selected response model.`);controls();scheduleDraw();notifyResponseChange();}
   else if(m.type==='error')fail(m.message);
  };
  worker.onerror=event=>fail(`Raman Worker failed${event?.message?`: ${event.message}${event.filename?` · ${event.filename}${event.lineno?`:${event.lineno}`:''}`:''}`:''}. Completed phonons and response modes are preserved.`);
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
function fields(){const parameters=manifest();return {schema:isCGCNN()?'macer-cgcnn-raman-response-v1':isFERE4()?'macer-raman-response-v4-experimental':isFERE()?'macer-raman-response-v3':isDFT()?'macer-raman-response-v2':'macer-raman-response-v1',identity,model:parameters?.id??null,parameters:parameters??null,metadataAvailable:!!parameters,absoluteIntensityAvailable:false,singleRamanTensorAvailable:!isDFT(),activityKind:isCGCNN()?'powder-activity-from-cgcnn-v2-mode-tensor':isAnyFERE()?'powder-activity-from-experimental-fitted-mode-tensor':isDFT()?'relative-profile':'bpm-arbitrary-units',qualification:isCGCNN()?'RESEARCH_PREVIEW_NOT_ACCURACY_QUALIFIED':isFERE4()?'EXPLORATORY_PREVIEW_ONLY':isFERE()?'PASS_APPROXIMATE_RAMAN_PREVIEW_V1':null,geometry:data?{lattice:data.lattice,atoms:data.atoms}:null,prepared,state,complete:state==='completed',elapsed_ms:elapsed,modes:rows,display:{...root.SpectrumView.settings(),normalization:'full-result maximum 100; changing view range does not renormalize; below-resolution noise not amplified',positive_cutoff_THz:.1,activity_resolution:P.manifest.activityResolution},spectrum:rows.length?drawingData():[]};}
$('raman-json').onclick=()=>download('estimated-raman.json',JSON.stringify(fields(),null,2));$('raman-parameters').onclick=()=>download('raman-parameters.json',JSON.stringify(manifest(),null,2));
$('raman-modes-csv').onclick=()=>{const header=['mode','frequency_THz','frequency_cm-1','activity_au','activity_per_A3','status','deltaQ_A_sqrt_amu','fd_error',...['re','im'].flatMap(p=>Array.from({length:9},(_,i)=>p+'_'+i))];download('raman-modes.csv',header.join(',')+'\n'+rows.map(m=>[m.modeIndex+1,m.frequencyTHz,m.frequencyCm,m.activity,m.activityPerVolume,m.status,m.deltaQ_A_sqrt_amu,m.fdError,...(m.tensorReal||Array(9).fill('')),...(m.tensorImag||Array(9).fill(''))].join(',')).join('\n'),'text/csv');};
$('raman-spectrum-csv').onclick=()=>download('raman-spectrum.csv','frequency_cm-1,raw_activity_density,relative_activity_density\n'+drawingData().map(r=>r.join(',')).join('\n'),'text/csv');
$('raman-svg').onclick=()=>download('estimated-raman.svg',root.SpectrumView.svg(drawingData(),'Estimated Raman · '+methodDescription()+'; full-result normalization'),'image/svg+xml');
document.addEventListener('macer-spectrum-view-change',scheduleDraw);
document.addEventListener('macer-phonon-clear',()=>{stop(false);revision++;data=null;gamma=-1;rows=[];identity=null;prepared=null;renderCoverage(null);elapsed=0;state='idle';modeOptions();controls();toggle(false);root.SpectrumView.setFrequencies([]);status('Open or calculate phonons first.');notifyResponseChange();});
document.addEventListener('macer-phonon-result',e=>load(e.detail.data));document.addEventListener('macer-phonon-selection',e=>{lastSelection=e.detail;refreshSelection();});root.addEventListener('resize',scheduleDraw);if(root.PhononBand.getData())load(root.PhononBand.getData());controls();
root.addEventListener('pagehide',()=>{worker?.terminate();worker=null;workerKind=null;workerCacheHash=null;});
const example=$('raman-si-example')||document.createElement('button');example.id='raman-si-example';example.type='button';example.textContent='Try calculated Si Raman · NEP';
if(!example.isConnected)$('phonon-results-empty').append(example);
example.onclick=async()=>{
 example.disabled=true;
 try{
  const response=await fetch('./examples/raman-si-nep.json?v=fd82cba2eb58c9fd',{credentials:'omit'});if(!response.ok)throw Error('Could not load the saved Si example.');const bytes=await response.arrayBuffer();
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');if(!root.RamanRuntime?.exampleSHA256||digest!==root.RamanRuntime.exampleSHA256)throw Error('Si example hash mismatch.');
  const saved=JSON.parse(new TextDecoder().decode(bytes));root.PhononBand.loadResult(saved.result,'Saved Si example · actual NEP phonons');toggle(true);const first=data.qpoints[gamma].bands.findIndex(b=>b.frequencyTHz>=.1);if(first>=0)selectMode(first);await start(false);
 }catch(error){status(error.message);toggle(true);}
 finally{example.disabled=false;}
};
if(root.__macerRamanPreviewExamplePending){delete root.__macerRamanPreviewExamplePending;toggle(true);const first=data?.qpoints?.[gamma]?.bands?.findIndex(b=>b.frequencyTHz>=.1)??-1;if(first>=0)selectMode(first);void start(false);}
function projectState(){return {method:$('raman-model').value,visible:!panel.hidden,confirmedAnalytic:$('raman-confirm').checked,response:identity&&rows.length?fields():null,display:root.SpectrumView.settings(),comparison:root.RamanModelComparison?.projectState?.()||null};}
async function restoreProject(saved){
 if(!saved){await root.RamanModelComparison?.restoreProject?.(null);return;}
 stop(false);const rev=revision;
 if(!['bpm','dft','fere','fere-r4','cgcnn'].includes(saved.method))throw Error('Unknown saved Raman model.');
 const response=saved.response,parameters=saved.method==='cgcnn'?root.CgcnnRamanRuntime:saved.method==='dft'?root.RamanDFTRuntime:saved.method==='fere-r4'?root.RamanFEREPreviewBundle:saved.method==='fere'?root.RamanFEREBundle:P.manifest;
 if(response){
  if(!data||gamma<0||data.nac)throw Error('Saved Raman response requires matching analytic Gamma modes.');
  const gammaData={lattice:data.lattice,atoms:data.atoms,q:data.qpoints[gamma].q,bands:data.qpoints[gamma].bands,execution:data.execution||data.calculator||null};
  const [phononHash,parameterHash]=await Promise.all([hash(gammaData),hash(parameters)]);
  if(rev!==revision)throw Error('Phonons changed while restoring Raman.');
  const expectedCandidateId=['fere','fere-r4'].includes(saved.method)?parameters.candidateId:null;
  if(response.identity?.phononHash!==phononHash||response.identity?.parameterHash!==parameterHash||response.identity?.kernel!==parameters.kernel||response.identity?.candidateId!==expectedCandidateId||!root.PhononProject.sameResponseRuntime(response.identity?.runtimeHashes,runtimeIdentity(saved.method)))throw Error('Saved Raman structure, modes, parameters or calculation runtime identity does not match.');
  const bands=data.qpoints[gamma].bands;
  if(!Array.isArray(response.modes)||response.modes.length>bands.length||response.complete&&response.modes.length!==bands.length||response.modes.some((m,i)=>m.modeIndex!==i||m.frequencyTHz!==bands[i].frequencyTHz||!Number.isFinite(m.activity)||m.activity<0||!Number.isFinite(m.frequencyCm)))throw Error('Invalid saved Raman mode results.');
 }
 $('raman-model').value=saved.method;$('raman-confirm').checked=!!saved.confirmedAnalytic;
 rows=response?JSON.parse(JSON.stringify(response.modes)):[];identity=response?.identity||null;prepared=response?.prepared||null;renderCoverage(prepared?.diagnostics||null);elapsed=response?.elapsed_ms||0;state=response?(response.complete?'completed':'stopped'):'idle';
 modeOptions();root.SpectrumView.restore(saved.display);await root.RamanModelComparison?.restoreProject?.(saved.comparison??null);toggle(!!saved.visible);refreshSelection();controls();
 status(response?`Restored Raman · ${rows.length} complete Γ modes · ${state}`:'Uses existing Γ phonons; no new force evaluations.');notifyResponseChange();
}
root.RamanPreview=Object.freeze({getResponse:fields,methodLabel,methodSummary,methodDescription,phononSourceLabel,projectState,restoreProject});
})(globalThis);
