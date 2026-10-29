'use strict';

const CACHE_NAME = 'macer-browser-model-assets-v2';
let wasmModule = null;
let wasmExports = null;
let engine = null;
let gpuEngine = null;
let gpuBatchTools = null;
let gpuFireSeed = null;
let gpuCellFireSeed = null;
let gpuBatchDisabled = false;
let gpuBatchFallbackReason = null;
let gpuBatchTopologyKey = null;
let gpuCellBatchDisabled = false;
let gpuCellBatchTopologyKey = null;
let activeRelaxSettings = null;
let lastAcceptedStep = 0;
let cpuFinishing = false;
let activeModelKey = null;
let activeModel = null;
let modelLoadMs = null;
let stopping = false;
let loadController = null;
let currentContext = null;
let calculationActive = false;
let calculationType = null;
let requireStepAck = false;
let awaitingStep = null;
let activeAssetBase = null;

const GPU_RELAX_BATCH_STEPS = 4;
const GPU_RELAX_BATCH_MAX_ATOMS = 8;
const GPU_RELAX_BATCH_MAX_EDGES = 224;
const GPU_RELAX_BATCH_MAX_TRIPLES = 1920;
const GPU_RELAX_BATCH_REQUESTED_BYTES_LIMIT = 128 * 1024 * 1024;
const NEP_GPU_RELAX_BATCH_MAX_ATOMS = 64;
const NEP_GPU_RELAX_BATCH_MAX_EDGES = 12000;

function emit(type, context, fields = {}) {
  self.postMessage({ type, ...(context || {}), ...fields });
}
function sameContext(a,b) {
  return !!a && !!b && ['loadId','runId','inputRevision','modelKey'].every(key=>a[key]===b[key]);
}

function wasmLinearMemoryBytes() {
  const buffer = wasmExports?.memory?.buffer;
  return buffer && Number.isSafeInteger(buffer.byteLength) ? buffer.byteLength : null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function modelIdentity(model) {
  return Object.fromEntries(['model_id', 'version', 'engine_format', 'model_format', 'weights_sha256', 'manifest_sha256', 'engine_sha256']
    .map(key => [key, model[key]]));
}

function orderedGraphKey(graph) {
  return canonical({atomic_numbers:graph.atomic_numbers,source:graph.source,destination:graph.destination,
    offsets:graph.offsets,triple_first:graph.triple_first,triple_second:graph.triple_second});
}

function gpuBatchEligible(structure,settings,graph) {
  if(!gpuBatchTools||gpuBatchDisabled||!gpuEngine||cpuFinishing)return false;
  if(!settings?.optimize_positions||settings.optimize_cell_shape||settings.optimize_cell_volume)return false;
  if(!Array.isArray(structure.pbc)||!structure.pbc.every(Boolean))return false;
  const masks=settings.movable||[];
  if(masks.some(mask=>!Array.isArray(mask)||mask.length!==3||mask.some(value=>value!==true)))return false;
  return structure.atomic_numbers.length<=GPU_RELAX_BATCH_MAX_ATOMS
    &&(!graph||(graph.source.length<=GPU_RELAX_BATCH_MAX_EDGES
      &&graph.triple_first.length<=GPU_RELAX_BATCH_MAX_TRIPLES));
}

function gpuCellBatchEligible(structure,settings,graph) {
  if(!gpuBatchTools?.GpuCellFireBatch||gpuCellBatchDisabled||!gpuEngine||cpuFinishing)return false;
  if(!settings?.optimize_positions||!settings.optimize_cell_shape||!settings.optimize_cell_volume)return false;
  if(!Array.isArray(structure.pbc)||!structure.pbc.every(Boolean))return false;
  if(settings.fractional_constraints&&settings.movable?.some(mask=>!Array.isArray(mask)||mask.length!==3||mask.some(value=>value!==true)))return false;
  if((settings.movable||[]).some(mask=>!Array.isArray(mask)||mask.length!==3||mask.some(value=>value!==true)))return false;
  return structure.atomic_numbers.length<=GPU_RELAX_BATCH_MAX_ATOMS
    &&(!graph||(graph.source.length<=GPU_RELAX_BATCH_MAX_EDGES
      &&graph.triple_first.length<=GPU_RELAX_BATCH_MAX_TRIPLES));
}

function nepGpuCellBatchEligible(structure,settings,graph) {
  if(activeModel?.adapter?.gpu_family!=='nep89'||!gpuBatchTools?.GpuCellFireBatch
      ||gpuCellBatchDisabled||!gpuEngine||cpuFinishing)return false;
  if(!settings?.optimize_positions||!settings.optimize_cell_shape||!settings.optimize_cell_volume)return false;
  if(!Array.isArray(structure.pbc)||!structure.pbc.every(Boolean))return false;
  if((settings.movable||[]).some(mask=>!Array.isArray(mask)||mask.length!==3||mask.some(value=>value!==true)))return false;
  return structure.atomic_numbers.length<=NEP_GPU_RELAX_BATCH_MAX_ATOMS
    &&(!graph||graph.centers.length<=NEP_GPU_RELAX_BATCH_MAX_EDGES);
}

function rows(data, rowCount, width) {
  return Array.from({length:rowCount},(_,index)=>Array.from(data.slice(index*width,(index+1)*width)));
}

function auditGpuSnapshot(snapshot,evaluation,timing,timingKey='gpu_timing') {
  const auditStarted=performance.now();
  const cpuEvaluation=engine[activeModel.adapter.evaluate](JSON.stringify(snapshot.structure));
  const audited=JSON.parse(engine.recheck_relax_evaluation_json(cpuEvaluation));
  cpuFinishing=audited.status==='running';
  return {...audited,gpu_evaluation:evaluation,[timingKey]:timing,
    evaluation_backend:'cpu-final-audit',
    cpu_final_audit:{passed:audited.status==='converged',elapsed_ms:performance.now()-auditStarted},
    cpu_refinement_required:cpuFinishing};
}

async function advanceNepGpuCellBatch(context,preparedStructure,started) {
  if(!nepGpuCellBatchEligible(preparedStructure,activeRelaxSettings,null))return false;
  if(gpuCellFireSeed?.valid===false){
    gpuCellBatchDisabled=true;gpuBatchFallbackReason='NEP device cell FIRE state was invalid';gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;
    return false;
  }
  const batchStructure=gpuCellFireSeed
    ?{...preparedStructure,positions_a:gpuCellFireSeed.positions,cell_a:gpuCellFireSeed.cell}
    :preparedStructure;
  let graph;
  try{graph=gpuEngine.createFixedCellBatchGraph(batchStructure);}
  catch(error){
    gpuCellBatchDisabled=true;gpuBatchFallbackReason=`NEP batch graph preparation failed: ${String(error?.message||error)}`;
    gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;return false;
  }
  if(!nepGpuCellBatchEligible(batchStructure,activeRelaxSettings,graph)){
    gpuCellBatchDisabled=true;gpuBatchFallbackReason=`NEP full-cell GPU FIRE is limited to ${NEP_GPU_RELAX_BATCH_MAX_ATOMS} atoms / ${NEP_GPU_RELAX_BATCH_MAX_EDGES} ordered neighbors`;
    gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;return false;
  }
  if(gpuCellBatchTopologyKey!==null&&gpuCellBatchTopologyKey!==graph.topology_key){
    gpuCellBatchDisabled=true;gpuBatchFallbackReason='NEP ordered neighbor/image topology changed between GPU FIRE segments';
    gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;return false;
  }
  const stepCount=Math.min(GPU_RELAX_BATCH_STEPS,Math.max(1,activeRelaxSettings.max_steps-lastAcceptedStep+1));
  const runtime=gpuEngine.rt,atomCount=batchStructure.atomic_numbers.length;
  let values,finishTiming,memory;
  try{
    runtime.begin({maxRequestedBufferBytes:GPU_RELAX_BATCH_REQUESTED_BYTES_LIMIT});
    const pressure=activeRelaxSettings.pressure_gpa/160.217_662_08;
    const batch=new gpuBatchTools.GpuCellFireBatch(runtime,batchStructure,pressure,gpuCellFireSeed);
    const readback=[];
    for(let index=0;index<stepCount;index++){
      if(stopping||currentContext!==context){await runtime.abort();return true;}
      const evaluatedPositions=batch.positionsTensor(),evaluatedCell=batch.cellTensor(),optimizerState=batch.state;
      const output=await gpuEngine.evaluate(batchStructure,{batch:true,graph,positions:evaluatedPositions,cell:evaluatedCell});
      readback.push(output.forces,output.energies,output.virials,output.stress,evaluatedPositions,evaluatedCell,optimizerState);
      batch.step(output.forces,output.stress);
      readback.push(batch.stateInfoTensor());
      await runtime.submitBatchStep([...readback,batch.mask,batch.state].map(tensor=>tensor.buffer));
    }
    readback.push(batch.state);
    values=await runtime.finish(readback);
    finishTiming=structuredClone(runtime.lastFinishTiming);memory=structuredClone(runtime.lastMemory);
  }catch(error){
    if(runtime.evaluationActive)await runtime.abort();
    if(stopping||currentContext!==context)return true;
    gpuCellBatchDisabled=true;gpuBatchFallbackReason=`NEP bounded full-cell GPU FIRE batch failed; using per-step evaluation: ${String(error?.message||error)}`;
    gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;return false;
  }
  if(stopping||currentContext!==context)return true;
  if(memory.requested_buffer_peak_bytes>GPU_RELAX_BATCH_REQUESTED_BYTES_LIMIT){
    gpuCellBatchDisabled=true;gpuBatchFallbackReason='NEP full-cell GPU FIRE requested buffer peak exceeded the 128 MiB batch guard';
    gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;return false;
  }
  const stride=8,generated=[];
  try{
    for(let index=0;index<stepCount;index++){
      const offset=index*stride,info=values[offset+7];
      if(!info||info.length!==5||info[4]<0.5||![...info].every(Number.isFinite))
        throw new Error(`invalid device FIRE state at segment step ${index+1}`);
      const structure={...batchStructure,positions_a:rows(values[offset+4],atomCount,3),cell_a:rows(values[offset+5],3,3)};
      const fire=gpuBatchTools.GpuCellFireBatch.seedFromReadback(values[offset+6],atomCount);
      const energies=Array.from(values[offset+1]),virials=rows(values[offset+2],atomCount,9);
      const cell=structure.cell_a;
      const volume=Math.abs(cell[0][0]*(cell[1][1]*cell[2][2]-cell[1][2]*cell[2][1])-cell[0][1]*(cell[1][0]*cell[2][2]-cell[1][2]*cell[2][0])+cell[0][2]*(cell[1][0]*cell[2][1]-cell[1][1]*cell[2][0]));
      const stress=rows(values[offset+3],3,3);
      const evaluation={energy_ev:energies.reduce((sum,value)=>sum+value,0),forces_ev_per_a:rows(values[offset],atomCount,3),
        stress_ev_per_a3:stress,energies_ev:energies,
        stresses_ev_per_a3:virials.map(row=>Array.from({length:3},(_,i)=>Array.from({length:3},(_,j)=>-row[i*3+j]/volume)))};
      generated.push({structure,evaluation,fire});
    }
    for(const item of generated){
      const candidate=gpuEngine.createFixedCellBatchGraph(item.structure);
      if(candidate.topology_key!==graph.topology_key)throw new Error('ordered neighbor/image topology changed inside the batch');
    }
  }catch(error){
    gpuCellBatchDisabled=true;gpuBatchFallbackReason=`NEP batch snapshot validation failed; discarding the segment: ${String(error?.message||error)}`;
    gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;return false;
  }
  if(stopping||currentContext!==context)return true;
  const snapshots=[];
  for(let index=0;index<generated.length;index++){
    const item=generated[index];
    if(index>0)engine.prepare_relax_evaluation_json();
    engine.replace_prepared_relax_cell_state_json(JSON.stringify(item.structure),JSON.stringify(item.fire.velocities),
      item.fire.dt,item.fire.alpha,Math.round(item.fire.positive),item.fire.initialized);
    let snapshot=JSON.parse(engine.accept_relax_evaluation_json(JSON.stringify(item.evaluation)));
    snapshot.evaluation_backend='webgpu-nep-batched-full-cell-evaluation-wasm-graph';
    snapshot.gpu_batch_timing={kind:'nep-full-cell-fire',segment_steps:stepCount,segment_index:index+1,
      submission_count:finishTiming.submitted_command_buffers,graph:{atoms:atomCount,edges:graph.centers.length},
      dispatch_count:memory.dispatch_count,compute_pass_count:memory.compute_pass_count,
      elapsed_ms:performance.now()-started,finish:finishTiming,memory};
    lastAcceptedStep=snapshot.step;
    if(snapshot.status!=='running'){
      snapshot=auditGpuSnapshot(snapshot,item.evaluation,snapshot.gpu_batch_timing);
      if(cpuFinishing)gpuCellBatchDisabled=true;
    }
    snapshots.push(snapshot);
    if(snapshot.status!=='running')break;
  }
  if(snapshots.at(-1)?.status==='running'&&snapshots.length===generated.length){
    gpuCellFireSeed=gpuBatchTools.GpuCellFireBatch.seedFromReadback(values.at(-1),atomCount);
    gpuCellBatchTopologyKey=graph.topology_key;
  }else{gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;}
  const evaluationMs=performance.now()-started,terminal=snapshots.at(-1)?.status!=='running';
  if(terminal)calculationActive=false;
  awaitingStep=!terminal&&requireStepAck?snapshots.at(-1).step:null;
  emit('batch',context,{step:snapshots.at(-1)?.step,evaluationMs,wasmLinearMemoryBytes:wasmLinearMemoryBytes(),snapshots,
    batch:{kind:'nep-full-cell-fire',requested_steps:stepCount,completed_steps:snapshots.length,
      submission_count:finishTiming.submitted_command_buffers,graph:{atoms:atomCount,edges:graph.centers.length},
      dispatch_count:memory.dispatch_count,compute_pass_count:memory.compute_pass_count,
      requested_buffer_peak_bytes:memory.requested_buffer_peak_bytes,elapsed_ms:evaluationMs,topology_verified:true,scope:memory.scope}});
  if(terminal)emit('finished',context,{step:snapshots.at(-1).step,state:snapshots.at(-1).status});
  else if(!requireStepAck)setTimeout(()=>advance(context),0);
  return true;
}

async function advanceGpuBatch(context,preparedStructure,started) {
  if(!gpuBatchEligible(preparedStructure,activeRelaxSettings,null))return false;
  if(gpuFireSeed?.valid===false){
    gpuBatchDisabled=true;gpuBatchFallbackReason='device FIRE state was invalid';gpuFireSeed=null;gpuBatchTopologyKey=null;
    return false;
  }
  const batchStructure={...preparedStructure,positions_a:gpuFireSeed?.positions||preparedStructure.positions_a};
  const graph=JSON.parse(engine.webgpu_ordered_graph_json(JSON.stringify(batchStructure)));
  if(!gpuBatchEligible(batchStructure,activeRelaxSettings,graph)){
    gpuBatchDisabled=true;gpuBatchFallbackReason=`structure exceeded fixed-cell batch eligibility limits (${graph.atomic_numbers.length} atoms, ${graph.source.length} edges, ${graph.triple_first.length} triples)`;gpuFireSeed=null;
    gpuBatchTopologyKey=null;
    return false;
  }
  const graphKey=orderedGraphKey(graph);
  if(gpuBatchTopologyKey!==null&&gpuBatchTopologyKey!==graphKey){
    gpuBatchDisabled=true;gpuBatchFallbackReason='ordered neighbor graph changed between GPU segments';
    gpuFireSeed=null;gpuBatchTopologyKey=null;
    return false;
  }
  const stepCount=Math.min(GPU_RELAX_BATCH_STEPS,Math.max(1,activeRelaxSettings.max_steps-lastAcceptedStep+1));
  const runtime=gpuEngine.rt;
  let batch,values,finishTiming,memory;
  try{
    const geometryGraph=gpuBatchTools.graphForContinuousPositions(graph,batchStructure.positions_a,batchStructure.cell_a);
    runtime.begin({maxRequestedBufferBytes:GPU_RELAX_BATCH_REQUESTED_BYTES_LIMIT});
    const movableMask=Array(batchStructure.atomic_numbers.length*3).fill(1);
    batch=new gpuBatchTools.GpuFireBatch(runtime,batchStructure.positions_a,movableMask,gpuFireSeed);
    const readback=[];
    for(let index=0;index<stepCount;index++){
      const output=gpuBatchTools.enqueueGraphBatch(gpuEngine,geometryGraph,batch.positionsTensor());
      const evaluatedPositions=batch.positionsTensor();
      readback.push(output.energy,output.forces,output.stress,evaluatedPositions);
      batch.step(output.forces);
      // Submit each FIRE boundary before recycling graph intermediates. Keep
      // complete result tensors and live optimizer state for final readback.
      await runtime.submitBatchStep([...readback,batch.mask,batch.state].map(tensor=>tensor.buffer));
    }
    readback.push(batch.state);
    values=await runtime.finish(readback);
    finishTiming=structuredClone(runtime.lastFinishTiming);
    memory=structuredClone(runtime.lastMemory);
  }catch(error){
    if(runtime.evaluationActive)await runtime.abort();
    if(stopping||currentContext!==context)return true;
    gpuBatchDisabled=true;gpuBatchFallbackReason=`bounded GPU batch failed; using per-step evaluation: ${String(error?.message||error)}`;
    gpuFireSeed=null;gpuBatchTopologyKey=null;
    return false;
  }
  if(stopping||currentContext!==context)return true;
  if(memory.requested_buffer_peak_bytes>GPU_RELAX_BATCH_REQUESTED_BYTES_LIMIT){
    gpuBatchDisabled=true;gpuBatchFallbackReason='requested WebGPU buffer peak exceeded the 128 MiB batch guard';gpuFireSeed=null;gpuBatchTopologyKey=null;
    return false;
  }

  const generated=[];
  for(let index=0;index<stepCount;index++){
    const result=values.slice(index*4,index*4+4);
    const positions=rows(result[3],batchStructure.atomic_numbers.length,3);
    const structure={...batchStructure,positions_a:positions};
    const evaluation={energy_ev:result[0][0],
      forces_ev_per_a:rows(result[1],batchStructure.atomic_numbers.length,3),
      stress_ev_per_a3:rows(result[2],3,3)};
    generated.push({structure,evaluation});
  }
  try{
    const expectedTopology=orderedGraphKey(graph);
    for(const item of generated){
      const candidate=JSON.parse(engine.webgpu_ordered_graph_json(JSON.stringify(item.structure)));
      if(orderedGraphKey(candidate)!==expectedTopology){
        gpuBatchDisabled=true;gpuBatchFallbackReason='ordered neighbor topology changed within the GPU segment';gpuFireSeed=null;
        gpuBatchTopologyKey=null;
        return false;
      }
    }
  }catch(error){
    gpuBatchDisabled=true;gpuBatchFallbackReason=`neighbor topology validation failed: ${String(error?.message||error)}`;gpuFireSeed=null;
    gpuBatchTopologyKey=null;
    return false;
  }
  if(stopping||currentContext!==context)return true;

  const snapshots=[];
  let committing=false;
  try{
    committing=true;
    for(let index=0;index<generated.length;index++){
      const item=generated[index];
      if(index>0)engine.prepare_relax_evaluation_json();
      engine.replace_prepared_relax_positions_json(JSON.stringify(item.structure.positions_a));
      let snapshot=JSON.parse(engine.accept_relax_evaluation_json(JSON.stringify(item.evaluation)));
      snapshot.evaluation_backend='webgpu-batched-evaluation-wasm-graph';
      snapshot.gpu_batch_timing={segment_steps:stepCount,segment_index:index+1,
        submission_count:finishTiming.submitted_command_buffers,
        graph:{atoms:graph.atomic_numbers.length,edges:graph.source.length,triples:graph.triple_first.length},
        dispatch_count:memory.dispatch_count,compute_pass_count:memory.compute_pass_count,
        elapsed_ms:performance.now()-started,finish:finishTiming,memory};
      lastAcceptedStep=snapshot.step;
      const gpuWasTerminal=snapshot.status!=='running';
      if(gpuWasTerminal){
        snapshot=auditGpuSnapshot(snapshot,item.evaluation,snapshot.gpu_batch_timing);
        if(cpuFinishing)gpuBatchDisabled=true;
      }
      snapshots.push(snapshot);
      if(gpuWasTerminal)break;
    }
  }catch(error){
    if(committing)throw error;
  }
  if(snapshots.at(-1)?.status==='running'&&snapshots.length===generated.length){
    gpuFireSeed=gpuBatchTools.GpuFireBatch.seedFromReadback(values.at(-1),batchStructure.atomic_numbers.length);
    gpuBatchTopologyKey=graphKey;
  }else {gpuFireSeed=null;gpuBatchTopologyKey=null;}
  const evaluationMs=performance.now()-started;
  const terminal=snapshots.at(-1)?.status!=='running';
  if(terminal)calculationActive=false;
  awaitingStep=!terminal&&requireStepAck?snapshots.at(-1).step:null;
  emit('batch',context,{step:snapshots.at(-1)?.step,evaluationMs,wasmLinearMemoryBytes:wasmLinearMemoryBytes(),snapshots,
    batch:{requested_steps:stepCount,completed_steps:snapshots.length,
      submission_count:finishTiming.submitted_command_buffers,
      graph:{atoms:graph.atomic_numbers.length,edges:graph.source.length,triples:graph.triple_first.length},
      dispatch_count:memory.dispatch_count,compute_pass_count:memory.compute_pass_count,
      requested_buffer_peak_bytes:memory.requested_buffer_peak_bytes,elapsed_ms:evaluationMs,
      topology_verified:true,scope:memory.scope}});
  if(terminal)emit('finished',context,{step:snapshots.at(-1)?.step,state:snapshots.at(-1)?.status});
  else if(!requireStepAck)setTimeout(()=>advance(context),0);
  return true;
}

async function advanceGpuCellBatch(context,preparedStructure,started) {
  if(!gpuCellBatchEligible(preparedStructure,activeRelaxSettings,null))return false;
  if(gpuCellFireSeed?.valid===false){
    gpuCellBatchDisabled=true;gpuBatchFallbackReason='device cell FIRE state was invalid';gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;
    return false;
  }
  const batchStructure=gpuCellFireSeed
    ?{...preparedStructure,positions_a:gpuCellFireSeed.positions,cell_a:gpuCellFireSeed.cell}
    :preparedStructure;
  const graph=JSON.parse(engine.webgpu_ordered_graph_json(JSON.stringify(batchStructure)));
  if(!gpuCellBatchEligible(batchStructure,activeRelaxSettings,graph)){
    gpuCellBatchDisabled=true;
    gpuBatchFallbackReason=`full-cell GPU FIRE is limited to ${GPU_RELAX_BATCH_MAX_ATOMS} atoms / ${GPU_RELAX_BATCH_MAX_EDGES} edges / ${GPU_RELAX_BATCH_MAX_TRIPLES} triples`;
    gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;
    return false;
  }
  const graphKey=orderedGraphKey(graph);
  const stepCount=Math.min(GPU_RELAX_BATCH_STEPS,Math.max(1,activeRelaxSettings.max_steps-lastAcceptedStep+1));
  const runtime=gpuEngine.rt;
  let values,finishTiming,memory;
  try{
    const geometryGraph=gpuBatchTools.graphForContinuousPositions(graph,batchStructure.positions_a,batchStructure.cell_a);
    runtime.begin({maxRequestedBufferBytes:GPU_RELAX_BATCH_REQUESTED_BYTES_LIMIT});
    const pressure=activeRelaxSettings.pressure_gpa/160.217_662_08;
    const batch=new gpuBatchTools.GpuCellFireBatch(runtime,batchStructure,pressure,gpuCellFireSeed);
    const readback=[];
    for(let index=0;index<stepCount;index++){
      const evaluatedPositions=batch.positionsTensor(),evaluatedCell=batch.cellTensor();
      const optimizerState=batch.state;
      const output=gpuBatchTools.enqueueGraphBatch(gpuEngine,geometryGraph,evaluatedPositions,evaluatedCell);
      readback.push(output.energy,output.forces,output.stress,evaluatedPositions,evaluatedCell,optimizerState);
      batch.step(output.forces,output.stress);
      const nextInfo=batch.stateInfoTensor();
      readback.push(nextInfo);
      await runtime.submitBatchStep([...readback,batch.mask,batch.state].map(tensor=>tensor.buffer));
    }
    readback.push(batch.state);
    values=await runtime.finish(readback);
    finishTiming=structuredClone(runtime.lastFinishTiming);
    memory=structuredClone(runtime.lastMemory);
  }catch(error){
    if(runtime.evaluationActive)await runtime.abort();
    if(stopping||currentContext!==context)return true;
    gpuCellBatchDisabled=true;gpuBatchFallbackReason=`bounded full-cell GPU FIRE batch failed; using synchronized per-step evaluation: ${String(error?.message||error)}`;
    gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;
    return false;
  }
  if(stopping||currentContext!==context)return true;
  if(memory.requested_buffer_peak_bytes>GPU_RELAX_BATCH_REQUESTED_BYTES_LIMIT){
    gpuCellBatchDisabled=true;gpuBatchFallbackReason='full-cell GPU FIRE requested buffer peak exceeded the 128 MiB batch guard';
    gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;
    return false;
  }

  const generated=[],stride=7,atomCount=batchStructure.atomic_numbers.length;
  for(let index=0;index<stepCount;index++){
    const offset=index*stride,info=values[offset+6];
    if(!info||info.length!==5||info[4]<0.5||![...info].every(Number.isFinite)){
      gpuCellBatchDisabled=true;gpuBatchFallbackReason=`full-cell GPU FIRE produced an invalid state at segment step ${index+1}`;
      gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;
      return false;
    }
    const structure={...batchStructure,positions_a:rows(values[offset+3],atomCount,3),cell_a:rows(values[offset+4],3,3)};
    const fire=gpuBatchTools.GpuCellFireBatch.seedFromReadback(values[offset+5],atomCount);
    generated.push({structure,evaluation:{energy_ev:values[offset][0],
      forces_ev_per_a:rows(values[offset+1],atomCount,3),stress_ev_per_a3:rows(values[offset+2],3,3)},fire});
  }
  let topologyChangeIndex=null;
  try{
    const expectedTopology=orderedGraphKey(graph);
    for(let index=0;index<generated.length;index++){
      const item=generated[index];
      const candidate=JSON.parse(engine.webgpu_ordered_graph_json(JSON.stringify(item.structure)));
      if(orderedGraphKey(candidate)!==expectedTopology){
        topologyChangeIndex=index;
        break;
      }
    }
  }catch(error){
    gpuCellBatchDisabled=true;gpuBatchFallbackReason=`full-cell neighbor topology validation failed: ${String(error?.message||error)}`;
    gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;
    return false;
  }
  if(topologyChangeIndex===0){
    gpuCellBatchDisabled=true;gpuBatchFallbackReason='ordered neighbor topology changed before the first full-cell GPU FIRE snapshot';
    gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;
    return false;
  }
  if(topologyChangeIndex!==null)generated.splice(topologyChangeIndex);
  if(stopping||currentContext!==context)return true;

  const snapshots=[];
  for(let index=0;index<generated.length;index++){
    const item=generated[index];
    if(index>0)engine.prepare_relax_evaluation_json();
    engine.replace_prepared_relax_cell_state_json(JSON.stringify(item.structure),JSON.stringify(item.fire.velocities),
      item.fire.dt,item.fire.alpha,Math.round(item.fire.positive),item.fire.initialized);
    let snapshot=JSON.parse(engine.accept_relax_evaluation_json(JSON.stringify(item.evaluation)));
    snapshot.evaluation_backend='webgpu-full-cell-batched-evaluation-wasm-graph';
    snapshot.gpu_batch_timing={kind:'full-cell-fire',segment_steps:stepCount,segment_index:index+1,
      submission_count:finishTiming.submitted_command_buffers,
      graph:{atoms:graph.atomic_numbers.length,edges:graph.source.length,triples:graph.triple_first.length},
      dispatch_count:memory.dispatch_count,compute_pass_count:memory.compute_pass_count,
      elapsed_ms:performance.now()-started,finish:finishTiming,memory};
    lastAcceptedStep=snapshot.step;
    const gpuWasTerminal=snapshot.status!=='running';
    if(gpuWasTerminal){
      snapshot=auditGpuSnapshot(snapshot,item.evaluation,snapshot.gpu_batch_timing);
      if(cpuFinishing)gpuCellBatchDisabled=true;
    }
    snapshots.push(snapshot);
    if(gpuWasTerminal)break;
  }
  if(snapshots.at(-1)?.status==='running'&&snapshots.length===generated.length){
    if(topologyChangeIndex!==null){
      gpuCellFireSeed=gpuBatchTools.GpuCellFireBatch.seedFromReadback(values[topologyChangeIndex*stride+5],atomCount);
      gpuCellBatchTopologyKey=null;
    }else{
      gpuCellFireSeed=gpuBatchTools.GpuCellFireBatch.seedFromReadback(values.at(-1),atomCount);
      gpuCellBatchTopologyKey=graphKey;
    }
  }else {gpuCellFireSeed=null;gpuCellBatchTopologyKey=null;}
  const evaluationMs=performance.now()-started,terminal=snapshots.at(-1)?.status!=='running';
  if(terminal)calculationActive=false;
  awaitingStep=!terminal&&requireStepAck?snapshots.at(-1).step:null;
  emit('batch',context,{step:snapshots.at(-1)?.step,evaluationMs,wasmLinearMemoryBytes:wasmLinearMemoryBytes(),snapshots,
    batch:{kind:'full-cell-fire',requested_steps:stepCount,completed_steps:snapshots.length,
      topology_rebuilt_next_segment:topologyChangeIndex!==null,
      submission_count:finishTiming.submitted_command_buffers,
      graph:{atoms:graph.atomic_numbers.length,edges:graph.source.length,triples:graph.triple_first.length},
      dispatch_count:memory.dispatch_count,compute_pass_count:memory.compute_pass_count,
      requested_buffer_peak_bytes:memory.requested_buffer_peak_bytes,elapsed_ms:evaluationMs,topology_verified:true,scope:memory.scope}});
  if(terminal)emit('finished',context,{step:snapshots.at(-1).step,state:snapshots.at(-1).status});
  else if(!requireStepAck)setTimeout(()=>advance(context),0);
  return true;
}

async function validateModel(model, modelKey, assetBase) {
  if (!model || model.model_key !== modelKey) throw new Error('Selected model identity does not match the request.');
  if (await sha256Hex(new TextEncoder().encode(canonical(modelIdentity(model)))) !== modelKey) {
    throw new Error('Selected model key validation failed.');
  }
  if (!model.assets || !model.adapter?.constructor) throw new Error('Selected model engine or asset metadata is incomplete.');
  const base = new URL(assetBase || self.location.href);
  if (base.origin === 'null') throw new Error('Calculation asset has no base origin.');
  for (const [name, asset] of Object.entries(model.assets)) {
    if (!Number.isSafeInteger(asset.size_bytes) || asset.size_bytes < 0 || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
      throw new Error(`${name} asset size or SHA-256 metadata is invalid.`);
    }
    if (asset.source === 'user-file') {
      if (asset.url !== undefined || asset.size_bytes < 1 || typeof asset.filename !== 'string' || !asset.filename) {
        throw new Error(`${name} local file asset metadata is invalid.`);
      }
    } else {
      if (asset.source !== undefined && asset.source !== 'same-origin') {
        throw new Error(`${name} calculation asset source type is unsupported.`);
      }
      const url = new URL(asset.url, base);
      if (url.origin !== base.origin) throw new Error(`${name} calculation assets must be same-origin.`);
    }
  }
}

async function responseBytes(response, asset, context, progress) {
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    progress(bytes.byteLength);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    if (stopping) throw new DOMException('model loading cancelled', 'AbortError');
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    progress(value.byteLength);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function verifiedAsset(name, asset, context, progress, cache, providedBytes) {
  if (asset.source === 'user-file') {
    if (!(providedBytes instanceof ArrayBuffer) && !ArrayBuffer.isView(providedBytes)) {
      throw new Error(`${asset.filename} file must be selected before running.`);
    }
    const bytes = providedBytes instanceof ArrayBuffer
      ? new Uint8Array(providedBytes)
      : new Uint8Array(providedBytes.buffer, providedBytes.byteOffset, providedBytes.byteLength);
    if (bytes.byteLength !== asset.size_bytes) throw new Error(`${asset.filename} file size does not match the pinned model.`);
    emit('model-progress', context, {
      phase: 'verifying-local-file', asset: name,
      downloaded_bytes: progress.downloadedBytes,
      total_bytes: progress.totalBytes,
    });
    if (await sha256Hex(bytes) !== asset.sha256) throw new Error(`${asset.filename} SHA-256 does not match the pinned model.`);
    return { bytes, downloadedBytes: 0, cacheStored: false, userSupplied: true };
  }
  const url = new URL(asset.url, activeAssetBase || self.location.href);
  const request = new Request(url, { credentials: 'same-origin' });
  if (cache) {
    const cached = await cache.match(request);
    if (cached) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      if (bytes.byteLength === asset.size_bytes && await sha256Hex(bytes) === asset.sha256) {
        emit('model-progress', context, { phase: 'checking-cache', asset: name, cache_hit: true, asset_ready_bytes: asset.size_bytes });
        return { bytes, downloadedBytes: 0, cacheStored: true };
      }
      await cache.delete(request);
      emit('model-progress', context, { phase: 'checking-cache', asset: name, cache_hit: false, cache_repaired: true });
    }
  }

  let response;
  try {
    response = await fetch(request, { signal: loadController?.signal });
  } catch (error) {
    if (stopping || error?.name === 'AbortError') throw error;
    const detail = String(error?.message || error);
    throw new Error(
      `Could not fetch model asset ${name}. The browser may be offline or unable to reach this origin. `
      + `For offline use, load this model while online and confirm its verified assets were cached. (${detail})`,
    );
  }
  if (!response.ok) throw new Error(`Could not read model file (${response.status}): ${url.pathname}`);
  const before = progress.downloadedBytes;
  const bytes = await responseBytes(response, asset, context, count => {
    progress.downloadedBytes += count;
    emit('model-progress', context, {
      phase: 'downloading', asset: name,
      downloaded_bytes: progress.downloadedBytes,
      total_bytes: progress.totalBytes,
      current_asset_bytes: progress.downloadedBytes - before,
    });
  });
  if (stopping) throw new DOMException('model loading cancelled', 'AbortError');
  if (bytes.byteLength !== asset.size_bytes) throw new Error(`${name} file size does not match the catalog.`);
  emit('model-progress', context, { phase: 'verifying', asset: name, downloaded_bytes: progress.downloadedBytes, total_bytes: progress.totalBytes });
  if (await sha256Hex(bytes) !== asset.sha256) throw new Error(`${name} SHA-256 does not match the catalog.`);

  let cacheStored = false;
  if (cache) {
    try {
      await cache.put(request, new Response(bytes, { headers: { 'content-type': response.headers.get('content-type') || 'application/octet-stream' } }));
      cacheStored = true;
    } catch (error) {
      emit('cache-warning', context, { message: `Could not cache verified ${name} file in the browser (${String(error?.message || error)}).` });
    }
  }
  return { bytes, downloadedBytes: bytes.byteLength, cacheStored };
}

async function prepareModel(message) {
  const context = {
    loadId: message.loadId,
    runId: message.runId,
    inputRevision: message.inputRevision,
    modelKey: message.modelKey,
  };
  if (engine && activeModelKey === message.modelKey) return { context, modelLoadMs };
  if (engine) {
    try { gpuEngine?.destroy(); } catch {}
    gpuEngine = null;
    try { engine.free?.(); } catch {}
    engine = null;
    wasmModule = null;
    wasmExports = null;
    activeModelKey = null;
    activeModel = null;
  }
  gpuBatchTools = null;gpuFireSeed = null;gpuCellFireSeed=null;gpuBatchDisabled = false;gpuBatchFallbackReason = null;gpuBatchTopologyKey=null;
  gpuCellBatchDisabled=false;gpuCellBatchTopologyKey=null;
  stopping = false;
  loadController = new AbortController();
  const started = performance.now();
  activeAssetBase = new URL(message.assetBase || self.location.href).href;
  await validateModel(message.model, message.modelKey, activeAssetBase);
  const assets = Object.entries(message.model.assets);
  const totalBytes = assets.reduce((sum, [, asset]) => sum + asset.size_bytes, 0);
  const progress = { downloadedBytes: 0, totalBytes };
  let cache = null;
  try {
    if (typeof caches !== 'undefined') cache = await caches.open(CACHE_NAME);
  } catch (error) {
    emit('cache-warning', context, { message: `Browser asset cache is unavailable (${String(error?.message || error)}).` });
  }

  emit('model-progress', context, { phase: 'checking-cache', downloaded_bytes: 0, total_bytes: totalBytes });
  const prepared = {};
  for (const [name, asset] of assets) {
    if (stopping) throw new DOMException('model loading cancelled', 'AbortError');
    prepared[name] = await verifiedAsset(name, asset, context, progress, cache, message.providedAssets?.[name]);
  }
  if (stopping) throw new DOMException('model loading cancelled', 'AbortError');
  const downloadMs = performance.now() - started;

  emit('model-progress', context, { phase: 'loading-engine', downloaded_bytes: progress.downloadedBytes, total_bytes: totalBytes });
  const engineStarted = performance.now();
  const glue = prepared.glue?.bytes;
  const wasm = prepared.wasm?.bytes;
  const weights = prepared.weights?.bytes;
  if (!glue || !wasm) throw new Error('Model catalog must include glue and WASM assets.');
  const moduleUrl = URL.createObjectURL(new Blob([new TextDecoder().decode(glue)], { type: 'text/javascript' }));
  try {
    wasmModule = await import(moduleUrl);
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
  if (stopping) throw new DOMException('model loading cancelled', 'AbortError');
  wasmExports = await wasmModule.default({ module_or_path: wasm });
  if (stopping) throw new DOMException('model loading cancelled', 'AbortError');
  const engineInitMs = performance.now() - engineStarted;
  const Engine = wasmModule[message.model.adapter.constructor];
  if (typeof Engine !== 'function') throw new Error(`WASM export ${message.model.adapter.constructor} is unavailable.`);
  const constructorAssets = message.model.adapter.constructor_assets || ['manifest', 'weights'];
  if (!Array.isArray(constructorAssets) || constructorAssets.length === 0) {
    throw new Error('Model adapter constructor_assets are invalid.');
  }
  const constructorArguments = constructorAssets.map(name => prepared[name]?.bytes);
  if (constructorArguments.some(bytes => !bytes)) {
    throw new Error(`Model adapter is missing required constructor assets: ${constructorAssets.join(', ')}`);
  }
  const weightsStarted = performance.now();
  engine = new Engine(...constructorArguments);
  if (message.model.adapter.runtime_backend === 'webgpu' && message.model.adapter.gpu_family === 'nep89') {
    if(!prepared.gpu_tensor?.bytes||!prepared.gpu_model?.bytes||!prepared.gpu_fire?.bytes)throw new Error('NEP WebGPU module assets are missing.');
    const tensorUrl=URL.createObjectURL(new Blob([prepared.gpu_tensor.bytes],{type:'text/javascript'}));
    const source=new TextDecoder().decode(prepared.gpu_model.bytes),dependency="from './tensor.js'";
    if(!source.includes(dependency)){URL.revokeObjectURL(tensorUrl);throw new Error('NEP GPU import contract mismatch.');}
    const modelUrl=URL.createObjectURL(new Blob([source.replace(dependency,`from ${JSON.stringify(tensorUrl)}`)],{type:'text/javascript'}));
    const fireUrl=URL.createObjectURL(new Blob([prepared.gpu_fire.bytes],{type:'text/javascript'}));
    try{
      const [module,fireModule]=await Promise.all([import(modelUrl),import(fireUrl)]);
      gpuEngine=await module.NepWebGpu.create(engine);
      gpuBatchTools={GpuFireBatch:fireModule.GpuFireBatch,GpuCellFireBatch:fireModule.GpuCellFireBatch};
    } finally {URL.revokeObjectURL(modelUrl);URL.revokeObjectURL(tensorUrl);URL.revokeObjectURL(fireUrl);}
    if(stopping){gpuEngine.destroy();gpuEngine=null;throw new DOMException('model loading cancelled','AbortError');}
  } else if (message.model.adapter.runtime_backend === 'webgpu') {
    if (!prepared.gpu_tensor?.bytes || !prepared.gpu_geometry?.bytes || !prepared.gpu_model?.bytes
      || !prepared.gpu_geometry_batch?.bytes || !prepared.gpu_batch?.bytes || !prepared.gpu_fire?.bytes) {
      throw new Error('WebGPU module assets are missing.');
    }
    const tensorUrl = URL.createObjectURL(new Blob([prepared.gpu_tensor.bytes], { type: 'text/javascript' }));
    const geometryUrl = URL.createObjectURL(new Blob([prepared.gpu_geometry.bytes], { type: 'text/javascript' }));
    const modelSource = new TextDecoder().decode(prepared.gpu_model.bytes);
    const dependency = "from './tensor.js'";
    if (!modelSource.includes(dependency)) throw new Error('WebGPU module import contract mismatch.');
    const geometryDependency = "from './geometry.js'";
    if (!modelSource.includes(geometryDependency)) throw new Error('WebGPU geometry import contract mismatch.');
    const modelUrl = URL.createObjectURL(new Blob([modelSource.replace(dependency, `from ${JSON.stringify(tensorUrl)}`).replace(geometryDependency, `from ${JSON.stringify(geometryUrl)}`)], { type: 'text/javascript' }));
    try {
      const module = await import(modelUrl);
      gpuEngine = await module.MatterSimWebGpu.create(prepared.manifest.bytes, weights, engine);
    } finally { URL.revokeObjectURL(modelUrl); URL.revokeObjectURL(tensorUrl); URL.revokeObjectURL(geometryUrl); }
    const geometryBatchUrl=URL.createObjectURL(new Blob([prepared.gpu_geometry_batch.bytes],{type:'text/javascript'}));
    const fireUrl=URL.createObjectURL(new Blob([prepared.gpu_fire.bytes],{type:'text/javascript'}));
    const batchSource=new TextDecoder().decode(prepared.gpu_batch.bytes);
    const batchDependency="from './geometry_batch.js'";
    if(!batchSource.includes(batchDependency))throw new Error('GPU batch module import contract mismatch.');
    const batchUrl=URL.createObjectURL(new Blob([batchSource.replace(batchDependency,`from ${JSON.stringify(geometryBatchUrl)}`)],{type:'text/javascript'}));
    try{
      const [batchModule,fireModule]=await Promise.all([import(batchUrl),import(fireUrl)]);
      gpuBatchTools={enqueueGraphBatch:batchModule.enqueueGraphBatch,graphForContinuousPositions:batchModule.graphForContinuousPositions,GpuFireBatch:fireModule.GpuFireBatch,
        GpuCellFireBatch:fireModule.GpuCellFireBatch};
    }finally{URL.revokeObjectURL(batchUrl);URL.revokeObjectURL(fireUrl);URL.revokeObjectURL(geometryBatchUrl);}
    if (stopping) { gpuEngine.destroy(); gpuEngine = null; throw new DOMException('model loading cancelled', 'AbortError'); }
  }
  const weightsInitMs = performance.now() - weightsStarted;
  activeModelKey = message.modelKey;
  activeModel = message.model;
  modelLoadMs = performance.now() - started;
  loadController = null;
  return { context, modelLoadMs, downloadMs, engineInitMs, weightsInitMs };
}

async function advance(context) {
  if (stopping || !engine || currentContext !== context || !calculationActive) return;
  try {
    const started = performance.now();
    let snapshot;
    if (gpuEngine && !cpuFinishing) {
      const structure = JSON.parse(engine.prepare_relax_evaluation_json());
      if(activeModel?.adapter?.gpu_family==='nep89'){
        if(await advanceNepGpuCellBatch(context,structure,started))return;
      }else{
        if(await advanceGpuCellBatch(context,structure,started))return;
        if (stopping || currentContext !== context) return;
        if(await advanceGpuBatch(context,structure,started))return;
        if (stopping || currentContext !== context) return;
      }
      const evaluation = await gpuEngine.evaluate(structure);
      if (stopping || currentContext !== context) return;
      snapshot = JSON.parse(engine.accept_relax_evaluation_json(JSON.stringify(evaluation)));
      snapshot.evaluation_backend = 'webgpu-evaluation-wasm-graph';
      snapshot.gpu_timing = gpuEngine.lastTiming;
      if (snapshot.status !== 'running') {
        snapshot = auditGpuSnapshot(snapshot,evaluation,snapshot.gpu_timing);
      }
    } else {
      snapshot = JSON.parse(engine[activeModel.adapter.advance_relax]());
      if (gpuEngine) snapshot.evaluation_backend = 'cpu-refinement';
    }
    if (stopping || currentContext !== context) return;
    const evaluationMs = performance.now() - started;
    if (snapshot.status !== 'running') calculationActive = false;
    lastAcceptedStep=snapshot.step;
    if(snapshot.status!=='running')gpuFireSeed=null;
    if(gpuBatchFallbackReason){snapshot.gpu_batch_fallback_reason=gpuBatchFallbackReason;gpuBatchFallbackReason=null;}
    awaitingStep = snapshot.status === 'running' && requireStepAck ? snapshot.step : null;
    emit('step', currentContext, { step: snapshot.step, evaluationMs, wasmLinearMemoryBytes: wasmLinearMemoryBytes(), snapshot });
    if (snapshot.status !== 'running') {
      emit('finished', currentContext, { step: snapshot.step, state: snapshot.status });
    } else if (!requireStepAck) {
      setTimeout(() => advance(context), 0);
    }
  } catch (error) {
    if (stopping || currentContext !== context) return;
    calculationActive = false;
    emit('error', context, { message: String(error?.message || error) });
  }
}

self.onmessage = async event => {
  const message = event.data || {};
  const context = {
    loadId: message.loadId,
    runId: message.runId,
    inputRevision: message.inputRevision,
    modelKey: message.modelKey,
  };
  try {
    if (calculationActive && ['loadModel','start','evaluate'].includes(message.type)) {
      if (sameContext(context,currentContext) && (message.type===calculationType || message.type==='loadModel')) return;
      throw new Error('Another calculation is running. Stop it before starting a new run.');
    }
    if (message.type === 'loadModel') {
      const loaded = await prepareModel(message);
      emit('ready', loaded.context, {
        modelId: activeModel.model_id,
        modelVersion: activeModel.version,
        modelLoadMs: loaded.modelLoadMs,
        downloadMs: loaded.downloadMs ?? 0,
        engineInitMs: loaded.engineInitMs ?? 0,
        weightsInitMs: loaded.weightsInitMs ?? 0,
        backend: gpuEngine ? 'webgpu-evaluation-wasm-graph' : 'cpu-wasm',
        gpuAdapter: gpuEngine?.rt.adapterInfo ?? null,
        gpuPrepareMs: gpuEngine?.prepareMs ?? null,
        wasmLinearMemoryBytes: wasmLinearMemoryBytes(),
      });
    } else if (message.type === 'start') {
      if (!engine || activeModelKey !== message.modelKey) throw new Error('Selected model is not ready.');
      stopping = false;
      cpuFinishing = false;
      currentContext = context;
      calculationType = 'start';
      requireStepAck = !!gpuEngine && message.waitForStepAcknowledgement === true;
      awaitingStep = null;
      gpuFireSeed=null;gpuCellFireSeed=null;gpuBatchDisabled=false;gpuBatchFallbackReason=null;gpuBatchTopologyKey=null;
      gpuCellBatchDisabled=false;gpuCellBatchTopologyKey=null;lastAcceptedStep=0;
      activeRelaxSettings=JSON.parse(JSON.stringify(message.settings));
      const start = activeModel.adapter.start_relax;
      engine[start](JSON.stringify(message.structure), JSON.stringify(message.settings));
      calculationActive = true;
      setTimeout(() => advance(context), 0);
    } else if (message.type === 'evaluate') {
      if (!engine || activeModelKey !== message.modelKey) throw new Error('Selected model is not ready.');
      currentContext = context;
      calculationType = 'evaluate';
      calculationActive = true;
      const started = performance.now();
      const evaluation = gpuEngine ? await gpuEngine.evaluate(message.structure)
        : JSON.parse(engine[activeModel.adapter.evaluate](JSON.stringify(message.structure)));
      if (stopping || currentContext !== context) return;
      calculationActive = false;
      const evaluationMs = performance.now() - started;
      emit('evaluation', context, { step: 0, evaluationMs, wasmLinearMemoryBytes: wasmLinearMemoryBytes(), structure: message.structure, evaluation,
        evaluationBackend: gpuEngine ? 'webgpu-evaluation-wasm-graph' : 'cpu-wasm', gpuTiming: gpuEngine?.lastTiming ?? null });
    } else if (message.type === 'continue') {
      if (!calculationActive || !sameContext(context,currentContext) || awaitingStep === null || message.step !== awaitingStep) return;
      awaitingStep = null;
      const activeContext = currentContext;
      setTimeout(() => advance(activeContext), 0);
    } else if (message.type === 'stop') {
      if (calculationActive && !sameContext(context,currentContext)) return;
      stopping = true;
      calculationActive = false;
      awaitingStep = null;
      try { gpuEngine?.destroy(); } catch {}
      loadController?.abort();
      emit('stopped', context);
    }
  } catch (error) {
    if (stopping && error?.name === 'AbortError') return;
    if (sameContext(context,currentContext) && message.type===calculationType) calculationActive = false;
    emit('error', context, { message: String(error?.message || error) });
  }
};
