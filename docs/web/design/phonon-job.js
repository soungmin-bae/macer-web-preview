/* Owns the Phonons input, local workers and complete calculation snapshots. */
(function(root){
  'use strict';
  const $=id=>document.getElementById(id),S=root.Structures;
  let catalog=null,input=null,revision=0,planner=null,modelWorker=null,job=null,preview=null,pendingPlan=null,pendingModel=null,lastSnapshot=null,inputViewer=null,lastResult=null;
  const example='Silicon primitive\n1.0\n0 2.715 2.715\n2.715 0 2.715\n2.715 2.715 0\nSi\n2\nDirect\n0 0 0\n0.25 0.25 0.25\n';
  const api=root.PhononJob={running:false,get state(){return job;},get result(){return lastResult;}};
  const clone=x=>JSON.parse(JSON.stringify(x));
  const native=s=>({atomic_numbers:s.atoms.map(a=>S.atomicNumber(a.element)),positions_a:s.atoms.map(a=>a.position),cell_a:s.cell,pbc:[true,true,true]});
  const fromNative=s=>({cell:s.cell_a,pbc:s.pbc,atoms:s.atomic_numbers.map((z,i)=>({element:S.elementSymbol(z),position:s.positions_a[i],mask:[true,true,true]}))});
  function status(text,error=false){$('phonon-job-status').textContent=text;$('phonon-job-status').dataset.state=error?'error':'ready';}
  function progress(stage,done=0,total=1){status(`${stage}${total>1?` · ${done} / ${total}`:''}`);$('phonon-job-progress').max=total;$('phonon-job-progress').value=done;if(job)job.stage=stage;}
  function settings(){
    const n=id=>Number($(id).value);
    const s={skipRelax:$('phonon-skip-relax').checked,supercellMode:$('phonon-supercell-mode').value,repeats:['a','b','c'].map(a=>n('phonon-supercell-'+a)),minimumLength:n('phonon-minimum-length'),displacement:n('phonon-displacement'),symprec:1e-5,path:$('phonon-path').value,samples:n('phonon-samples'),maxSteps:n('phonon-relax-steps'),pathMode:$('phonon-path-mode').value,nacEnabled:$('phonon-nac-enabled').checked,nacMethod:$('phonon-nac-method').value,born:$('phonon-born').value,nacDirection:$('phonon-nac-direction').value.trim()?$('phonon-nac-direction').value.trim().split(/\s+/).map(Number):null};
    if(!Number.isFinite(s.displacement)||s.displacement<=0||s.displacement>0.1)throw Error('Displacement must be greater than 0 and at most 0.1 Å.');
    if(!Number.isFinite(s.minimumLength)||s.minimumLength<1||s.minimumLength>100)throw Error('Minimum periodic length must be 1–100 Å.');
    if(!Number.isInteger(s.maxSteps)||s.maxSteps<1||s.maxSteps>10000)throw Error('Relax updates must be 1–10,000.');
    if(s.nacDirection&&(s.nacDirection.length!==3||!s.nacDirection.every(Number.isFinite)||Math.hypot(...s.nacDirection)===0))throw Error('Γ direction needs three finite, nonzero reciprocal coordinates.');
    return s;
  }
  function lock(busy){
    api.running=busy;
    document.querySelectorAll('#phonon-calculation input,#phonon-calculation textarea,#phonon-calculation select,#phonon-calculation button[data-edit]').forEach(el=>el.disabled=busy);
    $('phonon-calculate').disabled=busy||!input||!catalog;$('phonon-plan').disabled=busy||!input;$('phonon-job-stop').disabled=!busy;
    $('phonon-resume').disabled=busy||!job?.records||!Object.keys(job.records).length||job.completed;
    $('phonon-project-download').disabled=!job;$('phonon-yaml-download').disabled=!lastResult;$('phonon-born-download').disabled=!lastResult?.plan?.settings?.nacEnabled;
    $('phonon-minimum-length').disabled=busy||$('phonon-supercell-mode').value!=='auto';
    $('phonon-path').disabled=busy||$('phonon-path-mode').value==='auto';
    $('phonon-nac-settings').hidden=!$('phonon-nac-enabled').checked;
    $('phonon-primitive-download').disabled=busy||!preview;
    for(const a of ['a','b','c'])$('phonon-supercell-'+a).disabled=busy||$('phonon-supercell-mode').value!=='manual';
  }
  function parse(){
    revision++;preview=null;
    try{
      const s=S.parse($('phonon-structure').value,$('phonon-format').value);
      if(!s.cell||!s.pbc.every(Boolean))throw Error('Phonons need a fully periodic POSCAR or CIF structure.');
      input=s;$('phonon-input-state').textContent=`${s.atoms.length} atoms · periodic`;
      if(!inputViewer)inputViewer=root.CrystalViewer.create($('phonon-input-crystal'),null,null,null,null);
      inputViewer.setFrame({structure:s,display:{stylePreset:'phonon-vesta',showCell:true,showBonds:true,repeats:[1,1,1]},atomDragEnabled:false,interactionMode:'rotate'});
      status('Ready to prepare phonons');
    }catch(error){input=null;$('phonon-input-state').textContent=error.message;status(error.message,true);}
    lock(false);
  }
  function createPlanner(){
    planner?.terminate();planner=new Worker('./phonon-worker.js');
    planner.onerror=event=>fail(Error(event.message||'Phonon worker failed.'));
    planner.onmessage=async({data:m})=>{
      if(!job||m.jobId!==job.id||m.inputRevision!==job.revision)return;
      if(m.type==='error'){const e=Error(m.message);pendingPlan?.reject(e);pendingPlan=null;fail(e);return;}
      if(m.type==='planned'){
        preview=m.plan;job.plan=m.plan;
        $('phonon-plan-summary').textContent=`Space group ${m.plan.spaceGroup} · primitive ${m.plan.primitive.atoms.length} atoms · ${m.plan.repeat.join(' × ')} supercell (${m.plan.supercell.atoms.length} atoms) · ${m.plan.displacements.length} force evaluations`;
        $('phonon-path-summary').textContent=`${m.plan.path.source}${m.plan.path.extendedBravais?' · '+m.plan.path.extendedBravais:''}: ${(m.plan.path.segments||[]).map(([a,b])=>a.label+'–'+b.label).join(' · ')}`;
        $('phonon-born-order').textContent=`BORN independent-atom order: ${m.plan.bornOrder.map(a=>`${a.index+1} ${a.element}`).join(', ')}. Cartesian tensors for the calculation primitive.${m.plan.nac?.neutralityResidual>1e-5?' Charge neutrality correction applied (input residual '+m.plan.nac.neutralityResidual.toExponential(2)+').':''}`;
        pendingPlan?.resolve(m.plan);pendingPlan=null;
      }else if(m.type==='need-force'){
        try{
          progress('Forces',m.completed,m.total);
          const current=job;
          const e=await modelRequest('evaluate',{structure:m.structure,runId:`${job.id}:displacement:${m.displacementId}`},'evaluation');
          if(job!==current||!api.running)return;
          planner.postMessage({type:'force',jobId:job.id,inputRevision:job.revision,displacementId:m.displacementId,evaluation:e.evaluation,evaluationMs:e.evaluationMs,evaluationBackend:e.evaluationBackend,gpuTiming:e.gpuTiming});
        }catch(error){fail(error);}
      }else if(m.type==='checkpoint'){job.records=m.records;job.completedForces=m.completed;progress('Forces',m.completed,m.total);saveCheckpoint();}
      else if(m.type==='progress')progress(m.stage,m.completed,m.total);
      else if(m.type==='result'){
        lastResult=m;job.completed=true;job.result=m.result;job.forceConstants=m.forceConstants;job.elapsedMs=performance.now()-job.started;job.records=m.records;
        root.PhononBand.loadResult(m.result,`${job.model.display_name} · ${m.result.path?.source==='Manual'?'Manual path':m.result.path?.extendedBravais||'Auto path'}${m.result.nac?' · '+(m.result.nac.method==='gonze'?'Gonze–Lee':'Wang')+' NAC':''}`);
        status(`Completed · ${m.plan.displacements.length} force evaluations · ${(job.elapsedMs/1000).toFixed(1)} s`);
        $('phonon-job-progress').value=$('phonon-job-progress').max;
        modelWorker?.terminate();modelWorker=null;lock(false);saveCheckpoint();
        $('phonon-result').scrollIntoView({behavior:'smooth',block:'start'});
      }
    };
  }
  function prepare(s,previewOnly=false){return new Promise((resolve,reject)=>{pendingPlan={resolve,reject};planner.postMessage({type:'plan',jobId:job.id,inputRevision:job.revision,structure:s,execution:{modelId:job.model.model_id,modelKey:job.model.model_key,backend:job.model.backend,runtimeBackend:job.model.adapter.runtime_backend||'cpu',weightsSha256:job.model.weights_sha256,engineSha256:job.model.engine_sha256,assets:Object.fromEntries(Object.entries(job.model.assets).map(([key,a])=>[key,{sha256:a.sha256,sizeBytes:a.size_bytes}]))},settings:previewOnly?{...job.settings,nacEnabled:false}:job.settings});});}
  function modelRequest(type,fields,expected){
    if(pendingModel)return Promise.reject(Error('A model request is already pending.'));
    return new Promise((resolve,reject)=>{
      const context={loadId:job.id,runId:fields.runId||job.id,inputRevision:job.revision,modelKey:job.model.model_key};
      pendingModel={resolve,reject,expected,context};
      modelWorker.postMessage({type,...context,...fields});
    });
  }
  async function loadModel(){
    const loadingJob=job,bootstrap=root.MacerWorkerBootstrap.create(),asset=catalog.runtime_assets.worker;
    const source=await bootstrap.load(asset,new URL(asset.url,location.href).href);
    if(!api.running||job!==loadingJob)throw new DOMException('Stopped','AbortError');
    const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
    modelWorker=new Worker(url);URL.revokeObjectURL(url);
    modelWorker.onerror=e=>fail(Error(e.message||'Model worker failed.'));
    modelWorker.onmessage=({data:m})=>{
      const request=pendingModel;
      if(!request||!['loadId','runId','inputRevision','modelKey'].every(k=>m[k]===request.context[k]))return;
      if(m.type==='error'){pendingModel=null;request.reject(Error(m.message));}
      else if(m.type==='step'||m.type==='batch'){
        lastSnapshot=m.snapshot||m.snapshots.at(-1);job.relaxSnapshot=lastSnapshot;
        progress(`Relax · force ${lastSnapshot.max_force_ev_per_a?.toExponential(2)||'—'} eV/Å`,lastSnapshot.step,job.settings.maxSteps);
        inputViewer?.setFrame({structure:fromNative(lastSnapshot.structure),display:{stylePreset:'phonon-vesta',showCell:true,showBonds:true,repeats:[1,1,1]},atomDragEnabled:false,interactionMode:'rotate'});
      }else if(m.type===request.expected){pendingModel=null;request.resolve(m);}
    };
    const ready=await modelRequest('loadModel',{model:job.model,assetBase:new URL('./',location.href).href},'ready');
    if(job.model.adapter.runtime_backend==='webgpu'&&!ready.backend?.startsWith('webgpu-'))throw Error('WebGPU was selected but the model did not prepare a WebGPU evaluator. Select CPU / WASM explicitly to use the CPU.');
    job.modelPreparation={backend:ready.backend,gpuAdapter:ready.gpuAdapter,modelLoadMs:ready.modelLoadMs,downloadMs:ready.downloadMs,engineInitMs:ready.engineInitMs,weightsInitMs:ready.weightsInitMs,gpuPrepareMs:ready.gpuPrepareMs,wasmLinearMemoryBytes:ready.wasmLinearMemoryBytes};
  }
  function terminate(){planner?.terminate();planner=null;modelWorker?.terminate();modelWorker=null;const e=new DOMException('Stopped','AbortError');pendingPlan?.reject(e);pendingPlan=null;pendingModel?.reject(e);pendingModel=null;}
  function fail(error){if(error.name==='AbortError')return;terminate();if(job)job.error=error.message;status(error.message,true);lock(false);saveCheckpoint();}
  async function start(resume=false){
    if(api.running||!$('stop').disabled){status('Stop the active Relax calculation before starting phonons.',true);return;}
    try{
      let s,model;
      if(resume){
        if(!job?.preparedInput||job.model.model_key!==$('phonon-model').value)throw Error('Resume requires the original model and a prepared checkpoint.');
        if(!input||S.toPoscar(input)!==S.toPoscar(job.input)||JSON.stringify(Object.fromEntries(Object.keys(job.settings).map(k=>[k,settings()[k]])))!==JSON.stringify(job.settings))throw Error('Input or settings changed. Open the saved project to resume its original configuration.');
        s=clone(job.preparedInput);job.id=crypto.randomUUID();job.started=performance.now();job.revision=revision;
      }
      else{
        if(!input)throw Error('Enter a valid periodic structure first.');
        model=catalog.models.find(m=>m.model_key===$('phonon-model').value);if(!model)throw Error('Select a model.');
        if(input.atoms.some(a=>!model.supported_atomic_numbers.includes(S.atomicNumber(a.element))))throw Error('The selected model does not support every element in this structure.');
        s=clone(input);job={id:crypto.randomUUID(),revision,model:clone(model),input:s,settings:settings(),records:{},started:performance.now(),startedAt:new Date().toISOString(),completed:false};
      }
      const startingJob=job;lock(true);
      if(job.model.adapter.runtime_backend==='webgpu'){
        let adapter;
        try{adapter=navigator.gpu?await navigator.gpu.requestAdapter({powerPreference:'high-performance'}):null;}
        catch(error){if(job!==startingJob||!api.running)return;throw error;}
        if(job!==startingJob||!api.running)return;
        if(!adapter)throw Error('WebGPU is unavailable in this browser. Select a CPU / WASM model to run on the CPU.');
      }
      createPlanner();progress('Preparing supercell');await prepare(s);
      if(!api.running)return;
      progress('Loading model');await loadModel();
      if(!resume&&!job.settings.skipRelax){
        progress('Relax',0,job.settings.maxSteps);lastSnapshot=null;
        const finished=await modelRequest('start',{structure:native(s),settings:{max_steps:job.settings.maxSteps,fmax_ev_per_a:0.005,smax_gpa:0.16021766208,pressure_gpa:0,optimize_positions:true,optimize_cell_shape:true,optimize_cell_volume:true,fractional_constraints:true,movable:s.atoms.map(a=>a.mask||[true,true,true])}},'finished');
        if(finished.state!=='converged'||!lastSnapshot)throw Error('Initial Relax did not converge. Its last completed structure is available in the project file. Increase the limit or explicitly choose Skip relaxation.');
        s=fromNative(lastSnapshot.structure);progress('Preparing relaxed supercell');await prepare(s);
      }
      job.preparedInput=s;
      job.configurationHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({input:s,settings:job.settings,modelKey:job.model.model_key}))))).map(x=>x.toString(16).padStart(2,'0')).join('');
      progress('Forces',Object.keys(job.records).length,job.plan.displacements.length);
      planner.postMessage({type:'start',jobId:job.id,inputRevision:job.revision,records:job.records,modelPreparation:job.modelPreparation});
    }catch(error){fail(error);}
  }
  function download(name,content,type='application/json'){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function project(){return {schema:'macer-phonon-preview-project-v1',input:job.input,preparedInput:job.preparedInput,settings:job.settings,modelKey:job.model.model_key,model:job.model,modelPreparation:job.modelPreparation,records:job.records,configurationHash:job.configurationHash,relaxSnapshot:job.relaxSnapshot,completed:job.completed,result:job.result||null,forceConstants:job.forceConstants||null,error:job.error||null};}
  async function saveCheckpoint(){
    if(!job)return;
    try{const payload=project();const request=indexedDB.open('macer-phonon-preview',1);request.onupgradeneeded=()=>request.result.createObjectStore('projects');request.onsuccess=()=>{const db=request.result,tx=db.transaction('projects','readwrite');tx.objectStore('projects').put(payload,'latest');tx.oncomplete=()=>db.close();};}catch{}
  }
  $('phonon-structure').value=example;
  $('phonon-structure').addEventListener('input',()=>{if(!api.running)parse();});
  $('phonon-format').addEventListener('change',parse);
  $('phonon-copy-relax').onclick=()=>{const displayed=root.MacerRelax?.displayedStructure();if(displayed?.cell){$('phonon-structure').value=S.toPoscar(displayed);$('phonon-format').value='poscar';}else{$('phonon-structure').value=$('structure').value;$('phonon-format').value=$('format').value==='cif'?'cif':'poscar';}parse();};
  $('phonon-example').onclick=()=>{$('phonon-structure').value=example;$('phonon-format').value='poscar';parse();};
  $('phonon-nacl-example').onclick=()=>{$('phonon-structure').value='NaCl primitive\n1\n0 2.82 2.82\n2.82 0 2.82\n2.82 2.82 0\nNa Cl\n1 1\nDirect\n0 0 0\n.5 .5 .5\n';$('phonon-format').value='poscar';$('phonon-born').value='# Illustrative NaCl BORN values for workflow testing; not model predictions\n2.434 0 0 0 2.434 0 0 0 2.434\n1.1 0 0 0 1.1 0 0 0 1.1\n-1.1 0 0 0 -1.1 0 0 0 -1.1\n';$('phonon-nac-enabled').checked=false;parse();};
  $('phonon-born-download').onclick=()=>{if(lastResult?.plan?.settings?.born)download('BORN',lastResult.plan.settings.born,'text/plain');};
  $('phonon-structure-file').onchange=async e=>{const f=e.target.files?.[0];if(!f)return;$('phonon-format').value=/\.cif$/i.test(f.name)?'cif':'poscar';$('phonon-structure').value=await f.text();parse();};
  $('phonon-plan').onclick=async()=>{try{if(!input||api.running)return;job={id:crypto.randomUUID(),revision,input:clone(input),settings:settings(),records:{},model:catalog.models.find(m=>m.model_key===$('phonon-model').value)};lock(true);createPlanner();progress('Planning');await prepare(input,true);status('Supercell plan ready');lock(false);}catch(e){fail(e);}};
  $('phonon-calculate').onclick=()=>start(false);$('phonon-resume').onclick=()=>start(true);
  $('phonon-job-stop').onclick=()=>{if(!api.running)return;terminate();if(job)job.stopped=true;status('Stopped · completed force evaluations preserved');lock(false);saveCheckpoint();};
  $('phonon-project-download').onclick=()=>{if(job)download('phonon-project.json',JSON.stringify(project()));};
  $('phonon-yaml-download').onclick=()=>{if(lastResult)download('band.yaml',root.jsyaml.dump(lastResult.yaml,{noRefs:true,lineWidth:140}),'text/yaml');};
  async function openProject(p){
      if(p.schema!=='macer-phonon-preview-project-v1'||!p.preparedInput||!p.settings||!p.modelKey)throw Error('This is not a resumable phonon project.');
      const model=catalog.models.find(m=>m.model_key===p.modelKey);if(!model)throw Error('The project model is not in this package.');
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({input:p.preparedInput,settings:p.settings,modelKey:p.modelKey}))))).map(x=>x.toString(16).padStart(2,'0')).join('');
      if(hash!==p.configurationHash)throw Error('Project structure/settings/model hash does not match.');
      $('phonon-structure').value=S.toPoscar(p.input);$('phonon-format').value='poscar';parse();
      job={...p,id:crypto.randomUUID(),revision,model,started:performance.now()};$('phonon-model').value=p.modelKey;
      const s=p.settings;$('phonon-skip-relax').checked=s.skipRelax;$('phonon-supercell-mode').value=s.supercellMode;
      ['a','b','c'].forEach((a,i)=>$('phonon-supercell-'+a).value=s.repeats[i]);
      $('phonon-path-mode').value=s.pathMode||'manual';$('phonon-nac-enabled').checked=!!s.nacEnabled;$('phonon-nac-method').value=s.nacMethod||'gonze';$('phonon-born').value=s.born||'';$('phonon-nac-direction').value=s.nacDirection?.join(' ')||'';
      for(const [id,key] of [['phonon-minimum-length','minimumLength'],['phonon-displacement','displacement'],['phonon-path','path'],['phonon-samples','samples'],['phonon-relax-steps','maxSteps']])$(id).value=s[key];
      if(p.result){root.PhononBand.loadResult(p.result,'Project result');lastResult={result:p.result,yaml:root.PhononEngine.yamlObject(p.result),plan:{settings:p.settings}};}
      status(`Project opened · ${Object.keys(job.records).length} completed force evaluations`);lock(false);
  }
  $('phonon-project-open').onchange=async e=>{
    try{
      const f=e.target.files?.[0];if(!f)return;const p=JSON.parse(await f.text());
      await openProject(p);
    }catch(e){status(e.message,true);}
  };
  $('phonon-path-mode').onchange=()=>lock(api.running);$('phonon-nac-enabled').onchange=()=>lock(api.running);
  $('phonon-born-file').onchange=async e=>{const f=e.target.files?.[0];if(f&&!api.running)$('phonon-born').value=await f.text();};
  $('phonon-primitive-download').onclick=()=>{if(preview)download('POSCAR-primitive',S.toPoscar(preview.primitive),'text/plain');};
  $('phonon-supercell-mode').addEventListener('change',()=>lock(api.running));
  $('phonon-checkpoint-restore').onclick=()=>{
    if(api.running)return;
    const request=indexedDB.open('macer-phonon-preview',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('projects');
    request.onsuccess=()=>{const db=request.result,get=db.transaction('projects','readonly').objectStore('projects').get('latest');get.onsuccess=async()=>{db.close();try{if(!get.result)throw Error('No saved checkpoint is available.');await openProject(get.result);}catch(error){status(error.message,true);}};};
    request.onerror=()=>status('Could not open local checkpoint storage.',true);
  };
  api.redraw=()=>{if(input)inputViewer?.setFrame({structure:input,atomDragEnabled:false,interactionMode:'rotate'});};
  root.addEventListener('resize',api.redraw);
  fetch('./model-catalog.json',{cache:'no-cache'}).then(r=>{if(!r.ok)throw Error('Could not load the model catalog.');return r.json();}).then(c=>{catalog=c;const models=c.models.filter(m=>m.status==='available'&&Object.values(m.assets).every(a=>a.source!=='user-file'));$('phonon-model').replaceChildren(...models.map(m=>new Option(`${m.display_name} · ${m.backend}`,m.model_key)));parse();}).catch(e=>status(e.message,true));
})(globalThis);
