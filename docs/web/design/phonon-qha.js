/* Volume-resolved phonons and thermal properties from one equilibrium phonon plan. */
(function(root){
'use strict';

const $=id=>document.getElementById(id);
const plannerUrl='./phonon-worker.js?v=5d671540192d03b4';
const abortError=()=>new DOMException('Stopped','AbortError');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const subtract=(a,b)=>a.map((x,i)=>x-b[i]);
const scale=(v,factor)=>v.map(x=>x*factor);
const volume=([a,b,c])=>Math.abs(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]));
const rotate=(r,v)=>[0,1,2].map(i=>v.reduce((sum,x,j)=>sum+r[3*i+j]*x,0));
const fixedSettings={mode:'fixed-cell',optimizer:'lbfgs',maxSteps:500,forceToleranceEvA:0.005,stressToleranceGpa:0.16021766208,pressureGpa:0};
let source=null,active=null,project=null,selectedVolume=null,reviewRevision=0;

function useNac(value=source){
  return $('qha-nac-policy').value==='follow'&&!!(value?.activeNacEnabled??value?.settings?.nacEnabled);
}
function readGrid(){
  if($('qha-grid-mode').value==='custom')return $('qha-ratios').value.split(',').map(s=>s.trim()?Number(s):NaN);
  const low=$('qha-volume-min').valueAsNumber,high=$('qha-volume-max').valueAsNumber,step=$('qha-volume-step').valueAsNumber;
  const count=(high-low)/step;
  if(![low,high,step,count].every(Number.isFinite)||step<=0||low<=-100||low>0||high<0||count<4||count>20||Math.abs(count-Math.round(count))>1e-7||Math.abs(low/step-Math.round(low/step))>1e-7){
    throw Error('Choose 5–21 equally spaced volumes, including 0% and both endpoints.');
  }
  return Array.from({length:Math.round(count)+1},(_,i)=>Number((1+(low+i*step)/100).toFixed(10)));
}
function thermalOptions(){
  const mesh=['a','b','c'].map(axis=>$('qha-mesh-'+axis).valueAsNumber);
  const max=$('qha-max-temperature').valueAsNumber,step=$('qha-temperature-step').valueAsNumber;
  if(mesh.some(n=>!Number.isInteger(n)||n<2||n>100)||!Number.isFinite(max)||max<0||max>10000||!Number.isFinite(step)||step<1||Math.ceil(max/step)>500)throw Error('Check the q-mesh and temperature settings (at most 501 temperatures).');
  const temperatures=Array.from({length:Math.floor(max/step)+1},(_,i)=>i*step);
  if(temperatures.at(-1)<max)temperatures.push(max);
  return {mesh,temperatures};
}
function updateGrid(){
  const custom=$('qha-grid-mode').value==='custom';
  $('qha-custom-wrap').hidden=!custom;
  for(const id of ['qha-volume-min','qha-volume-max','qha-volume-step'])$(id).closest('label').hidden=custom;
  const plan=source?.plan,primitive=plan?.primitive||source?.forceConstants&&source?.preparedInput;
  const cell=primitive?.cell;
  const v0=cell?volume(cell):null;
  $('qha-nac-note').textContent=useNac()
    ? 'NAC uses the equilibrium Born charges and dielectric tensor at every volume (fixed-tensor approximation). The cell-dependent NAC prefactor is evaluated at each volume.'
    : 'NAC is off for the QHA thermal mesh.';
  $('qha-input-summary').textContent=source?`${source.model.display_name} · ${source.model.adapter.runtime_backend==='webgpu'?'WebGPU':'CPU / WASM'} · relaxed equilibrium cell${v0?' · '+v0.toFixed(5)+' Å³':''}${plan?' · '+plan.supercell.atoms.length+' supercell atoms':''}`:'';
  try{
    const ratios=readGrid();
    if(ratios.length<5||ratios.length>21||!ratios.includes(1)||ratios.some((v,i)=>!Number.isFinite(v)||v<=0||(i&&v<=ratios[i-1])))throw Error('Enter 5–21 increasing positive ratios, including 1.');
    $('qha-grid-summary').textContent=`${ratios.length} volumes · volume change ${((ratios[0]-1)*100).toFixed(2)}% to ${((ratios.at(-1)-1)*100).toFixed(2)}% · lattice-length change ${((Math.cbrt(ratios[0])-1)*100).toFixed(2)}% to ${((Math.cbrt(ratios.at(-1))-1)*100).toFixed(2)}%`;
    return ratios;
  }catch(error){$('qha-grid-summary').textContent=error.message;return null;}
}
async function reviewGrid(){
  const ratios=updateGrid();
  if(!ratios||!source)return;
  const ticket=++reviewRevision;
  const owner=source,controller=new AbortController(),session=workerSession(controller.signal);
  try{
    status('Checking saved volumes…');
    const reference=await referencePlan(owner,session),thermal=thermalOptions();
    const plan=await projectPlan(reference,owner,ratios,thermal);
    const saved=await loadVolumeProject(plan,root.CalculationProject.createIndexedDbStore());
    if(owner!==source||ticket!==reviewRevision)return;
    const body=$('qha-review-table').tBodies[0];body.replaceChildren();
    const v0=volume(reference.primitive.cell);
    for(const ratio of ratios){
      const task=saved?.tasks.find(t=>t.settings.volumeRatio===ratio);
      const row=body.insertRow();
      for(const value of [ratio.toFixed(4),(v0*ratio).toFixed(5),reference.supercell.atoms.length,task?.status==='completed'?'Saved result':'New calculation'])row.insertCell().textContent=value;
    }
    $('qha-review-wrap').hidden=false;
    const reused=saved?.tasks.filter(t=>t.status==='completed').length||0;
    status(`${ratios.length} volumes · ${reused} saved · ${ratios.length-reused} new calculations`);
  }catch(error){status(error.message);}finally{session.close();}
}
$('qha-review').onclick=reviewGrid;
for(const id of ['qha-grid-mode','qha-volume-min','qha-volume-max','qha-volume-step','qha-ratios','qha-mesh-a','qha-mesh-b','qha-mesh-c','qha-max-temperature','qha-temperature-step','qha-nac-policy'])$(id).addEventListener('input',()=>{reviewRevision++;updateGrid();$('qha-review-wrap').hidden=true;controls();});

function scaledCell(cell,factor){return cell.map(row=>scale(row,factor));}

function displacedPlan(reference,task,geometry,model){
  const deltas=geometry.positions_a.map((p,i)=>subtract(p,task.structure.positions_a[i]));
  const {primitiveIndices,mapping:{forwardAtomPermutations,rotationsCartesian}}=reference;
  for(const [op,permutation] of forwardAtomPermutations.entries()){
    const offsets=permutation.map((j,i)=>subtract(deltas[primitiveIndices[j]],rotate(rotationsCartesian[op],deltas[primitiveIndices[i]])));
    if(offsets.some(offset=>Math.hypot(...subtract(offset,offsets[0]))>reference.settings.symprec)){
      throw Error('Internal relaxation changed the reference symmetry. Its displacement plan cannot be reused at this volume.');
    }
  }
  const factor=Math.cbrt(task.settings.volumeRatio);
  return {...reference,nac:task.settings.nac?.parameters||null,execution:model,
    primitive:{...reference.primitive,cell:geometry.cell_a,
      atoms:reference.primitive.atoms.map((atom,i)=>({...atom,position:geometry.positions_a[i]}))},
    supercell:{...reference.supercell,cell:scaledCell(reference.supercell.cell,factor),
      atoms:reference.supercell.atoms.map((atom,i)=>({...atom,
        position:scale(atom.position,factor).map((x,j)=>x+deltas[primitiveIndices[i]][j])}))}};
}

function workerSession(signal){
  const workers=new Set();
  const requests=new Set();
  const worker=url=>{
    signal.throwIfAborted();
    const instance=new Worker(url);
    workers.add(instance);
    return instance;
  };
  function request(instance,message,onMessage){
    signal.throwIfAborted();
    return new Promise((resolve,reject)=>{
      function finish(callback,value){
        if(!requests.delete(cancel))return;
        instance.onmessage=instance.onerror=instance.onmessageerror=null;
        callback(value);
      }
      const cancel=()=>finish(reject,abortError());
      const fail=error=>finish(reject,error);
      requests.add(cancel);
      instance.onmessage=({data})=>{
        if(message.jobId!==undefined&&data.jobId!==message.jobId)return;
        if(message.runId!==undefined&&['loadId','runId','inputRevision','modelKey'].some(key=>data[key]!==message[key]))return;
        if(data.type==='error'){fail(Error(data.message));return;}
        Promise.resolve().then(()=>onMessage(data,result=>finish(resolve,result))).catch(fail);
      };
      instance.onerror=e=>fail(Error(e.message||'Calculation worker failed.'));
      instance.onmessageerror=()=>fail(Error('Could not read the calculation worker result.'));
      try{instance.postMessage(message);}catch(error){fail(error);}
    });
  }
  function closeWorker(instance){workers.delete(instance);instance.terminate();}
  function close(){
    for(const cancel of requests)cancel();
    for(const instance of workers)closeWorker(instance);
  }
  signal.addEventListener('abort',close,{once:true});
  return {worker,request,closeWorker,close};
}

async function referencePlan(owner,session){
  const enabled=useNac(owner);
  const settings={...owner.settings,nacEnabled:enabled};
  if(owner.plan&&(!enabled||owner.plan.nac))return {...owner.plan,settings,nac:enabled?owner.plan.nac:null};
  const planner=session.worker(plannerUrl);
  try{
    return await session.request(planner,{type:'qha-plan',jobId:crypto.randomUUID(),inputRevision:owner.revision,
      structure:owner.preparedInput,settings},(m,done)=>{if(m.type==='planned')done(m.plan);});
  }finally{session.closeWorker(planner);}
}

function createRunner(reference,owner,session,signal,onStage){
  const model=owner.model;
  const context={loadId:crypto.randomUUID(),inputRevision:owner.revision,modelKey:model.model_key};
  let modelWorker,runId=0;
  const modelRequest=(type,fields,handle)=>session.request(modelWorker,{type,...context,runId:++runId,...fields},handle);
  return {
    async prepare(identity){
      const response=await fetch('./model-catalog.json',{cache:'no-cache',signal});
      if(!response.ok)throw Error('Could not load the model catalog.');
      const asset=(await response.json()).runtime_assets.worker;
      const source=await root.MacerWorkerBootstrap.create().load(asset,new URL(asset.url,location.href).href);
      const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
      try{modelWorker=session.worker(url);}finally{URL.revokeObjectURL(url);}
      const ready=await modelRequest('loadModel',{model,assetBase:new URL('./',location.href).href},(m,done)=>{if(m.type==='ready')done(m);});
      const expectedBackend=model.adapter.runtime_backend==='webgpu'?'webgpu-':'cpu-wasm';
      if(!ready.backend?.startsWith(expectedBackend)||ready.modelId!==identity.modelId)throw Error('QHA could not prepare the selected phonon model and backend.');
      return identity;
    },
    async runRelax(task,{signal:queueSignal,onSnapshot}){
      queueSignal.throwIfAborted();
      const {optimizer,maxSteps,forceToleranceEvA,stressToleranceGpa,pressureGpa,volumeRatio,thermal}=task.settings;
      let tail=Promise.resolve(),last=null;
      const progress=stage=>onStage(volumeRatio,stage);
      progress('Relaxing internal coordinates');
      const finished=await modelRequest('start',{structure:task.structure,settings:{
        optimizer,max_steps:maxSteps,fmax_ev_per_a:forceToleranceEvA,smax_gpa:stressToleranceGpa,pressure_gpa:pressureGpa,
        optimize_positions:true,optimize_cell_shape:false,optimize_cell_volume:false,fractional_constraints:false,
        movable:task.structure.atomic_numbers.map(()=>[true,true,true]),
      }},async(m,done)=>{
        if(m.type==='step'||m.type==='batch'){
          tail=tail.then(async()=>{
            for(const snapshot of m.snapshots||[m.snapshot]){
              if(!same(snapshot.structure.cell_a,task.structure.cell_a)||!same(snapshot.structure.atomic_numbers,task.structure.atomic_numbers)){
                throw Error('Fixed-cell relaxation changed the lattice or primitive atom order.');
              }
              await onSnapshot(snapshot);
              last=snapshot;
            }
          });
          await tail;
        }else if(m.type==='finished'){
          await tail;
          done(m);
        }else if(m.type==='stopped')throw abortError();
      });
      if(finished.state!=='converged'||!last)return {status:'max_steps'};
      queueSignal.throwIfAborted();
      const geometry=last.structure;
      const plan=displacedPlan(reference,task,geometry,{modelKey:model.model_key,modelId:model.model_id,runtimeBackend:model.adapter.runtime_backend||'cpu'});
      const planner=session.worker(plannerUrl);
      let qha;
      try{
        const envelope={jobId:crypto.randomUUID(),inputRevision:owner.revision};
        const send=(type,data)=>{signal.throwIfAborted();planner.postMessage({type,...envelope,...data});};
        qha=await session.request(planner,{type:'qha-plan',...envelope,plan,options:thermal},async(m,done)=>{
          if(m.type==='planned')send('start');
          if(m.type==='need-force'){
            progress(`Displacement forces · ${m.completed+1}/${m.total}`);
            const evaluation=await modelRequest('evaluate',{structure:m.structure},(event,resolve)=>{if(event.type==='evaluation')resolve(event);});
            send('force',{displacementId:m.displacementId,evaluation:evaluation.evaluation,
              evaluationMs:evaluation.evaluationMs,evaluationBackend:evaluation.evaluationBackend,gpuTiming:evaluation.gpuTiming});
          }
          if(m.type==='forces-complete'){progress('Building force constants');send('finish');}
          if(m.type==='qha-progress'&&(m.done===m.total||m.done%512===0))progress(`${m.stage} · ${m.done}/${m.total}`);
          if(m.type==='qha-result')done({forceConstants:m.forceConstants,thermal:m.thermal,forceEvaluations:m.forceEvaluations});
        });
      }finally{session.closeWorker(planner);}
      qha.volumeRatio=volumeRatio;
      qha.volumeAngstrom3=volume(geometry.cell_a);
      return {status:'converged',geometry,totalEnergyEv:last.evaluation.energy_ev,qha};
    },
    stop:session.close,
  };
}

async function projectPlan(reference,owner,ratios,thermal){
  const api=root.CalculationProject;
  const model={modelKey:owner.model.model_key,modelId:owner.model.model_id,
    weightsSha256:owner.model.weights_sha256,engineSha256:owner.model.engine_sha256};
  const base=root.PhononEngine.engineStructure(reference.primitive);
  const {primitive,supercell,primitiveIndices,primitiveRepresentativeIndices,supercellMatrix,masses,mapping,displacements,siteMaps}=reference;
  const datasetSha256=await api.hash({schema:'macer-qha-v1',primitive,supercell,primitiveIndices,primitiveRepresentativeIndices,
    supercellMatrix,masses,mapping,displacements,siteMaps,symprec:reference.settings.symprec,ratios,thermal,fixedSettings,model});
  const nac=reference.nac?{policy:'fixed-equilibrium-tensors-v1',parameters:reference.nac}:null;
  const boundHash=nac?await api.hash({datasetSha256,nac}):datasetSha256;
  const projectId='qha-'+boundHash;
  const tasks=ratios.map(volumeRatio=>{
    const factor=Math.cbrt(volumeRatio);
    const taskId='volume-'+volumeRatio;
    return {type:'qha-volume',taskId,phaseId:taskId,settings:{...fixedSettings,volumeRatio,thermal,...(nac?{nac}:{})},
      structure:{...base,cell_a:scaledCell(base.cell_a,factor),positions_a:scaledCell(base.positions_a,factor)}};
  });
  return {projectId,datasetSha256:boundHash,model,tasks};
}

async function loadVolumeProject(plan,store){
  const saved=project?.projectId===plan.projectId&&project.state==='completed'?project:await store.load(plan.projectId);
  if(saved)return saved;
  const next=await root.CalculationProject.createProject(plan);
  if(!project||!same(project.model,next.model))return next;
  await root.CalculationProject.verifyTaskIdentities(project);
  for(const task of next.tasks){
    const old=project.tasks.find(t=>t.status==='completed'&&same(t.structure,task.structure)&&same(t.settings,task.settings));
    if(!old)continue;
    task.status='completed';task.attempts=old.attempts;task.restartCount=old.restartCount;
    task.attemptedEvaluations=old.attemptedEvaluations;
    task.result={...old.result,taskKey:task.taskKey,phaseId:task.phaseId};
  }
  next.metrics.completed=next.tasks.filter(t=>t.status==='completed').length;
  next.metrics.forceStressEvaluations=next.tasks.reduce((n,t)=>n+t.attemptedEvaluations,0);
  return next;
}

function controls(){
  $('phonon-qha-panel').hidden=!source;
  $('phonon-continue-qha').hidden=!source;
  $('qha-start').disabled=!source||!!active;
  let saved=false;
  try{saved=project?.tasks.every(t=>t.status==='completed')&&same(readGrid(),project.tasks.map(t=>t.settings.volumeRatio))&&same(thermalOptions(),project.tasks[0].settings.thermal)&&!!project.tasks[0].settings.nac===useNac();}catch{}
  $('qha-start').textContent=active?'Calculating…':saved?'View results':'Calculate / resume';
  $('qha-start').dataset.saved=String(!!saved);
  $('qha-stop').disabled=!active||active.controller.signal.aborted;
  for(const input of document.querySelectorAll('#phonon-qha-panel .qha-settings-grid input, #qha-grid-mode, #qha-ratios, #qha-nac-policy, #qha-review'))input.disabled=!!active;
  $('qha-download').disabled=!project||!!active;
  root.PhononGruneisenUi?.setBusy(!!active);
  $('qha-show-fit').disabled=!!active||!project?.tasks.every(task=>task.status==='completed');
}

function renderThermal(){
  const thermal=project?.tasks.find(task=>task.taskId===selectedVolume)?.result.qha.thermal;
  const table=$('qha-thermal-table');
  table.tBodies[0].replaceChildren();
  $('qha-thermal-result').hidden=!thermal;
  if(!thermal)return;
  $('qha-thermal-summary').textContent=thermal.stability.status==='unstable'
    ? `${thermal.stability.imaginaryCount} imaginary modes · minimum ${thermal.stability.minimumMode.frequencyTHz.toFixed(5)} THz. Harmonic thermal values are undefined.`
    : `${thermal.mesh.join(' × ')} · ${thermal.qWeightSum} q-points`;
  table.hidden=!thermal.rows;
  for(const record of thermal.rows||[]){
    const row=table.tBodies[0].insertRow();
    for(const field of Object.values(record))row.insertCell().textContent=Number(field.toPrecision(8));
  }
}

function render(value){
  project=value;
  root.PhononGruneisenUi?.setSource(source,value);
  const completed=value?.tasks.filter(task=>task.status==='completed')||[];
  if(!completed.some(task=>task.taskId===selectedVolume)){
    selectedVolume=(completed.find(task=>task.settings.volumeRatio===1)??completed[0])?.taskId??null;
  }
  const picker=$('qha-volume-detail');
  picker.replaceChildren(...completed.map(task=>new Option(task.settings.volumeRatio.toFixed(3),task.taskId)));
  picker.value=selectedVolume??'';
  renderThermal();
  const body=$('qha-table').tBodies[0];
  body.replaceChildren();
  for(const task of value?.tasks||[]){
    const row=body.insertRow();
    row.dataset.status=task.status;
    const result=task.result;
    const qha=result?.qha;
    const v=qha?.volumeAngstrom3??volume(task.structure.cell_a);
    const thermal=qha?.thermal;
    const status=thermal?.stability.status==='unstable'
      ? `${thermal.stability.imaginaryCount} imaginary modes`
      : thermal ? `${thermal.rows.length} temperatures · ${thermal.mesh.join('×')}`
      : task.status.replaceAll('_',' ');
    for(const field of [task.settings.volumeRatio.toFixed(3),v.toFixed(5),
      result?.totalEnergyEv.toFixed(7)??'—',qha?.forceEvaluations??'—',
      thermal?.zpe_ev_per_atom?.toPrecision(7)??'—',status])row.insertCell().textContent=field;
  }
  $('qha-table-wrap').hidden=!value;
  controls();
}

const status=message=>{$('qha-status').textContent=message;};

async function start(){
  if(!source||active)return;
  const owner=source;
  const controller=new AbortController();
  const session=workerSession(controller.signal);
  const current={controller,queue:null};
  active=current;
  const update=message=>{if(active===current&&source===owner)status(message);};
  controls();
  try{
    const ratios=readGrid();
    if(ratios.length<5||ratios.length>21||!ratios.includes(1)||ratios.some((v,i)=>!Number.isFinite(v)||v<=0||(i>0&&v<=ratios[i-1]))){
      throw Error('Enter 5–21 distinct, increasing positive volume ratios, including 1.');
    }
    if(owner.relaxSnapshot?.status!=='converged'||owner.settings.skipRelax||owner.settings.pressureGpa!==0){
      throw Error('Complete a zero-pressure cell relaxation and phonon calculation first.');
    }

    const thermal=thermalOptions();
    update('Preparing volume grid and checking saved results…');
    const reference=await referencePlan(owner,session);
    const store=root.CalculationProject.createIndexedDbStore();
    const plan=await projectPlan(reference,owner,ratios,thermal);
    const run=async lock=>{
      if(!lock)throw Error('This volume grid is already running in another tab.');
      if(project&&project.projectId!==plan.projectId)root.PhononQhaFitUi?.reset();
      const saved=await loadVolumeProject(plan,store);
      controller.signal.throwIfAborted();
      render(saved);
      const reused=saved.tasks.filter(t=>t.status==='completed').length;
      update(`${reused}/${ratios.length} saved · ${ratios.length-reused} to calculate`);
      const runner=createRunner(reference,owner,session,controller.signal,(ratio,stage)=>update(`V/V₀ ${ratio.toFixed(3)} · ${stage}`));
      current.queue=new root.CalculationQueue({project:saved,runner,store,onProgress:event=>{
        if(active!==current||owner!==source||event.type==='task-progress')return;
        render(event.project);
        const count=event.project.tasks.filter(t=>t.status==='completed').length;
        update(event.type==='task-completed'?`${count}/${ratios.length} volumes saved · ${reused} reused`:
          `${count}/${ratios.length} saved · V/V₀ ${event.task.settings.volumeRatio.toFixed(3)} · ${event.type.replaceAll('-',' ')}`);
      }});
      // Abort a stop that occurs while the model is loading or a task is being saved.
      controller.signal.addEventListener('abort',()=>{void current.queue.cancel();},{once:true});
      const result=await current.queue.run();
      if(active!==current||owner!==source)return;
      render(result);
      const count=result.tasks.filter(t=>t.status==='completed').length;
      const detail=result.tasks.find(t=>t.attemptSummary?.error)?.attemptSummary.error;
      update(`${count}/${ratios.length} volumes saved · ${reused} reused · ${result.state}${detail?' · '+detail:''}`);
    };
    if(navigator.locks)await navigator.locks.request(plan.projectId,{ifAvailable:true},run);
    else await run(true);
  }catch(error){
    update(error.name==='AbortError'?'Stopped. Completed volumes can be resumed.':error.message);
  }finally{
    session.close();
    if(active===current){active=null;controls();}
  }
}

function stop(){
  active?.controller.abort();
  controls();
}

function setSource(value){
  const next=value?.forceConstants?.values&&value.preparedInput&&value.model?value:null;
  if(source===next)return;
  stop();
  source=next;
  reviewRevision++;
  $('qha-review-wrap').hidden=true;
  updateGrid();
  root.PhononQhaFitUi?.reset();
  render(null);
  status('Each volume is saved after relaxation, force constants and thermal sampling finish.');
}

$('phonon-continue-qha').onclick=()=>{
  const panel=$('phonon-qha-panel');
  panel.open=true;
  panel.scrollIntoView({block:'start'});
};
$('qha-start').onclick=()=>{$('qha-start').dataset.saved==='true'?root.PhononQhaFitUi.open(project):start();};
$('qha-stop').onclick=stop;
$('qha-volume-detail').onchange=event=>{
  selectedVolume=event.target.value;
  renderThermal();
};
$('qha-show-fit').onclick=()=>root.PhononQhaFitUi.open(project);
$('qha-download').onclick=()=>{
  if(!project)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}));
  const link=document.createElement('a');
  link.href=url;
  link.download='qha-volumes.json';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};
function projectFields(owner){
  if(source!==owner||!project?.tasks.every(task=>task.status==='completed'))return {};
  return {qhaWorkflow:{schema:'macer-qha-workflow-v1',phononConfigurationHash:owner.configurationHash,
    volumes:project,...root.PhononQhaFitUi.projectFields(project),...root.PhononGruneisenUi.projectFields()}};
}

async function validateWorkflow(owner){
  const saved=owner.qhaWorkflow;
  if(!saved)return null;
  if(saved.schema!=='macer-qha-workflow-v1'||saved.phononConfigurationHash!==owner.configurationHash||
    !owner.completed||!owner.result||!owner.forceConstants?.values)throw Error('Saved QHA volumes do not match these phonons.');
  const volumes=await root.CalculationProject.verifyTaskIdentities(saved.volumes);
  if(volumes.model.modelKey!==owner.modelKey||(volumes.tasks.length<5||volumes.tasks.length>21)||
    !volumes.tasks.every(task=>task.type==='qha-volume'&&task.status==='completed')){
    throw Error('The QHA workflow requires 5–21 completed volumes for the saved model.');
  }
  if(saved.gruneisen)await root.PhononGruneisenUi.validateSaved(saved.gruneisen,owner,volumes);
  if(saved.fit){
    root.PhononQhaEos.validateSaved(volumes,saved.fit);
    if(!saved.fit.rows.some(row=>row.temperatureK===saved.temperatureK))throw Error('Saved QHA temperature is outside the fit grid.');
  }
  return {...saved,volumes};
}

function restore(saved){
  const volumes=saved.volumes;
  $('qha-ratios').value=volumes.tasks.map(task=>task.settings.volumeRatio).join(', ');
  const {mesh,temperatures}=volumes.tasks[0].settings.thermal;
  for(const [i,axis] of ['a','b','c'].entries())$('qha-mesh-'+axis).value=mesh[i];
  $('qha-max-temperature').value=temperatures.at(-1);
  if(temperatures.length>1)$('qha-temperature-step').value=temperatures[1]-temperatures[0];
  $('qha-grid-mode').value='custom';
  $('qha-nac-policy').value=volumes.tasks[0].settings.nac?'follow':'off';
  updateGrid();
  render(volumes);
  status(`${volumes.tasks.length}/${volumes.tasks.length} saved volumes reopened`);
  $('phonon-qha-panel').open=true;
  if(saved.fit)root.PhononQhaFitUi.restore(volumes,saved);
  if(saved.gruneisen)root.PhononGruneisenUi.restore(saved.gruneisen);
}

root.PhononQha={setSource,projectFields,validateWorkflow,restore};
})(globalThis);
