'use strict';
importScripts('./structures.js','./phonon-symmetry.js','./atomic-masses.js','./seekpath-data.js','./phonon-path.js','./phonon-nac.js','./phonon-engine.js');
let active=null,plan=null,records={},kernel=null;
const emit=(type,fields={})=>self.postMessage({type,jobId:active?.jobId,inputRevision:active?.inputRevision,...fields});
async function libraries(){
  const [moyo,k]=await Promise.all([import('./wasm-moyo/moyo_wasm.js'),import('./wasm-phonon/phonon_kernel.js')]);
  await Promise.all([moyo.default(),k.default()]);kernel=k;return moyo;
}
function next(){const d=plan.displacements.find(d=>!records[d.id]);if(d){emit('need-force',{displacementId:d.id,structure:PhononEngine.displaced(plan,d.id),completed:Object.keys(records).length,total:plan.displacements.length});}else finish().catch(error=>emit('error',{message:error.message}));}
async function finish(){
  if(plan.execution?.runtimeBackend==='webgpu'){
    const peaks=Object.values(records).map(r=>r.gpuTiming?.gpu_memory?.requested_buffer_peak_bytes).filter(Number.isFinite);
    const observedPeakBytes=peaks.length?Math.max(...peaks):null;
    plan.validation.webgpuRequestedBuffers={budgetBytes:128*1024*1024,observedPeakBytes,passed:observedPeakBytes!==null&&observedPeakBytes<=128*1024*1024,scope:'Requested WebGPU buffer accounting, not physical VRAM. Functional/numerical completion does not pass the resource gate.'};
  }
  emit('progress',{stage:'Force constants',completed:0,total:1});
  const fc=PhononEngine.forceConstants(plan,records,kernel);
  const result=await PhononEngine.bands(plan,fc,kernel,(completed,total,stage='Bands')=>emit('progress',{stage,completed,total}));
  emit('result',{result,yaml:PhononEngine.yamlObject(result),forceConstants:fc,records,plan});
}
self.onmessage=async ({data:m})=>{
  try{
    if(m.type==='plan'){
      active={jobId:m.jobId,inputRevision:m.inputRevision};const moyo=await libraries();
      plan=PhononEngine.plan(m.structure,m.settings,moyo,kernel);plan.execution=m.execution||null;records={};emit('planned',{plan});
    }else if(!active||m.jobId!==active.jobId||m.inputRevision!==active.inputRevision)return;
    else if(m.type==='start'){
      if(plan.execution)plan.execution.modelPreparation=m.modelPreparation||null;
      records=m.records||{};
      for(const [id,r] of Object.entries(records)){
        if(!plan.displacements[Number(id)]||!Array.isArray(r.forces)||r.forces.length!==plan.supercell.atoms.length||r.forces.some(v=>!Array.isArray(v)||v.length!==3||v.some(x=>!Number.isFinite(x))))throw Error('Checkpoint contains an invalid completed force evaluation.');
        if(plan.execution?.runtimeBackend==='webgpu'&&!r.evaluationBackend?.startsWith('webgpu-'))throw Error('This checkpoint has no verified WebGPU force provenance. Its saved result is preserved; start a new calculation to regenerate the forces.');
      }
      next();
    }
    else if(m.type==='force'){
      const expected=plan.displacements.find(d=>!records[d.id]);
      if(!expected||m.displacementId!==expected.id)throw Error('Unexpected or duplicate displacement result.');
      const forces=m.evaluation?.forces_ev_per_a;
      if(!Array.isArray(forces)||forces.length!==plan.supercell.atoms.length||forces.some(v=>!Array.isArray(v)||v.length!==3||v.some(x=>!Number.isFinite(x))))throw Error('Model returned an invalid force array.');
      const expectedBackend=plan.execution?.runtimeBackend==='webgpu'?'webgpu-':'cpu-wasm';
      if(!m.evaluationBackend?.startsWith(expectedBackend))throw Error('The force evaluation backend does not match the selected model. No fallback result was accepted.');
      records[m.displacementId]={forces,energy_ev:m.evaluation.energy_ev,stress_ev_per_a3:m.evaluation.stress_ev_per_a3,evaluationMs:m.evaluationMs,evaluationBackend:m.evaluationBackend,gpuTiming:m.gpuTiming||null};
      emit('checkpoint',{records,completed:Object.keys(records).length,total:plan.displacements.length});next();
    }
  }catch(error){emit('error',{message:String(error.message||error)});}
};
