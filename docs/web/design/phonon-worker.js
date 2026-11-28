'use strict';
importScripts('./phonon-directional.js?v=cdddb6897a1be4bf','./phonon-gruneisen.js?v=e1c43f02a7c77558','./structures.js?v=dc2ff9d2e6b1d6d5','./phonon-symmetry.js?v=153e9aeb21fb5b11','./atomic-masses.js?v=83635e6f0dbac057','./seekpath-data.js?v=87c29088df56c93a','./phonon-path.js?v=84c687cabdab27e8','./phonon-nac.js?v=565f76f71c846622','./phonon-supercell-lattice.js?v=a2acac4dca6e61f2','./phonon-engine.js?v=4901f733fb1e340a','./phonon-dos.js?v=9dd46ff2f8f77504','./phonon-thermal.js?v=ef1dc061043cf932');
let active=null,plan=null,records={},kernel=null,qhaOptions=null,modeBudget=null;
const emit=(type,fields={})=>self.postMessage({type,jobId:active?.jobId,inputRevision:active?.inputRevision,...fields});
async function libraries(){
  const [moyo,k]=await Promise.all([import('./wasm-moyo/moyo_wasm.js?v=a5c1c5609f875497'),import('./wasm-phonon/phonon_kernel.js?v=204158cca6c7ffb9')]);
  await Promise.all([moyo.default(),k.default()]);kernel=k;return moyo;
}
function next(){const d=plan.displacements.find(d=>!records[d.id]);if(d){emit('need-force',{displacementId:d.id,structure:PhononEngine.displaced(plan,d.id),completed:Object.keys(records).length,total:plan.displacements.length});}else emit('forces-complete');}
async function finish(){
  if(plan.execution?.runtimeBackend==='webgpu'){
    const peaks=Object.values(records).map(r=>r.gpuTiming?.gpu_memory?.requested_buffer_peak_bytes).filter(Number.isFinite);
    const observedPeakBytes=peaks.length?Math.max(...peaks):null;
    plan.validation.webgpuRequestedBuffers={budgetBytes:128*1024*1024,observedPeakBytes,passed:observedPeakBytes!==null&&observedPeakBytes<=128*1024*1024,scope:'Requested WebGPU buffer accounting, not physical VRAM. Functional/numerical completion does not pass the resource gate.'};
  }
  emit('progress',{stage:'Force constants',completed:0,total:1});
  const fc=PhononEngine.forceConstants(plan,records,kernel);
  if(qhaOptions){
    const thermal=await PhononThermal.run(plan,fc,kernel,qhaOptions,
      (stage,done,total)=>emit('qha-progress',{stage,done,total}));
    emit('qha-result',{forceConstants:fc,thermal,forceEvaluations:Object.keys(records).length});
    return;
  }
  const result=plan.settings.jobKind==='gamma'?await PhononEngine.gammaResult(plan,fc,kernel,(completed,total,stage='Γ modes')=>emit('progress',{stage,completed,total})):await calculateBands(fc);
  emit('result',{result,forceConstants:fc,records,plan});
}
function checkBandBudget(plan,budget){modeBudget=budget;return PhononEngine.fitBandBudget(plan,budget);}
function calculateBands(fc){return PhononEngine.withBandMemoryRetries(plan,modeBudget,()=>PhononEngine.bands(plan,fc,kernel,(completed,total,stage='Bands')=>emit('progress',{stage,completed,total})),(from,to)=>emit('progress',{stage:`Memory recovery · band points ${from} → ${to} per segment · reusing force constants`,completed:0,total:1}));}
self.onmessage=async ({data:m})=>{
  try{
    if(m.type==='gruneisen-mesh'){
      active={jobId:m.jobId,inputRevision:m.inputRevision};const moyo=await libraries();
      const reference=PhononEngine.plan(m.structure,{...m.settings,nacEnabled:false},moyo,kernel);
      const mesh=m.mesh,total=mesh?.reduce((a,b)=>a*b,1),n=reference.masses.length*3;
      if(!mesh||mesh.length!==3||mesh.some(x=>!Number.isInteger(x)||x<2||x>31)||total*n>500000)throw Error('Reduce the mesh or primitive cell (maximum 500,000 q-mode values).');
      const completed=m.completed||0;
      if(!Number.isInteger(completed)||completed<0||completed>total)throw Error('Invalid mesh checkpoint.');
      for(let start=completed;start<total;start+=24){
        const qs=Array.from({length:Math.min(24,total-start)},(_,i)=>{let k=start+i;return mesh.map(size=>{const j=k%size;k=Math.floor(k/size);return (j>size/2?j-size:j)/size;});});
        const r=m.group?PhononGruneisen.runDirectional(reference,m.project,m.centerForceConstants,kernel,qs,m.group,m.stepPercent,m.centerHash,true):PhononGruneisen.run(reference,m.project,kernel,qs,m.stepPercent,true);
        const {samples:chunk,...metadata}=r;emit('gruneisen-mesh-chunk',{start,samples:chunk,total,metadata});
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      emit('gruneisen-mesh-complete',{total});
    }else if(m.type==='directional-gruneisen'){
      active={jobId:m.jobId,inputRevision:m.inputRevision};const moyo=await libraries();
      const reference=PhononEngine.plan(m.structure,m.settings,moyo,kernel);
      emit('gruneisen-result',{result:PhononGruneisen.runDirectional(reference,m.project,m.centerForceConstants,kernel,m.qpoints,m.group,m.stepPercent,m.centerHash)});
    }else if(m.type==='gruneisen'){
      active={jobId:m.jobId,inputRevision:m.inputRevision};
      const moyo=await libraries();
      const reference=PhononEngine.plan(m.structure,m.settings,moyo,kernel);
      const result=reference.nac?await PhononGruneisen.runNac(reference,m.project,kernel,m.pathPoints||m.qpoints.map(q=>({q})),m.stepPercent,stage=>emit('gruneisen-progress',{stage})):PhononGruneisen.run(reference,m.project,kernel,m.qpoints,m.stepPercent);
      emit('gruneisen-result',{result});
    }else if(m.type==='qha-plan'){
      active={jobId:m.jobId,inputRevision:m.inputRevision};
      const moyo=await libraries();
      plan=m.plan||PhononEngine.plan(m.structure,m.settings,moyo,kernel);
      qhaOptions=m.options||null;
      records={};
      emit('planned',{plan});
    }else if(m.type==='dos'){
      active={jobId:m.jobId,inputRevision:m.inputRevision};const moyo=await libraries();
      plan=m.plan||PhononEngine.plan(m.structure,m.settings,moyo,kernel);
      const result=await PhononDos.run(plan,m.forceConstants,kernel,m.dosSettings,m.checkpoint,(stage,fields)=>emit('dos-'+stage,fields));
      emit('dos-result',{result});
    }else if(m.type==='thermal'){
      active={jobId:m.jobId,inputRevision:m.inputRevision};const moyo=await libraries();
      plan=m.plan||PhononEngine.plan(m.structure,m.settings,moyo,kernel);
      if(!plan.execution&&m.modelKey)plan.execution={modelKey:m.modelKey};
      const result=await PhononThermal.run(plan,m.forceConstants,kernel,m.options,
        (stage,done,total)=>emit('thermal-progress',{stage,done,total}));
      emit('thermal-result',{result});
    }else if(m.type==='plan'){
      active={jobId:m.jobId,inputRevision:m.inputRevision};const moyo=await libraries();
      plan=PhononEngine.plan(m.structure,m.settings,moyo,kernel);plan.execution=m.execution||null;checkBandBudget(plan,m.bandBudget);records={};emit('planned',{plan});
    }else if(m.type==='bands'){
      active={jobId:m.jobId,inputRevision:m.inputRevision};await libraries();
      plan=m.plan;records=m.records||{};
      if(!plan||!m.forceConstants?.values)throw Error('Reusing NAC bands requires saved force constants and a complete plan.');
      checkBandBudget(plan,m.bandBudget);
      emit('progress',{stage:'Bands · reusing completed force evaluations',completed:0,total:1});
      const result=plan.settings.jobKind==='gamma'?await PhononEngine.gammaResult(plan,m.forceConstants,kernel,(completed,total,stage='Γ modes')=>emit('progress',{stage,completed,total})):await calculateBands(m.forceConstants);
      emit('result',{result,forceConstants:m.forceConstants,records,plan});
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
    else if(m.type==='finish'){
      if(plan.displacements.some(d=>!records[d.id]))throw Error('Missing force evaluations.');
      await finish();
    }
    else if(m.type==='force'){
      const expected=plan.displacements.find(d=>!records[d.id]);
      if(!expected||m.displacementId!==expected.id)throw Error('Unexpected or duplicate displacement result.');
      const forces=m.evaluation?.forces_ev_per_a;
      if(!Array.isArray(forces)||forces.length!==plan.supercell.atoms.length||forces.some(v=>!Array.isArray(v)||v.length!==3||v.some(x=>!Number.isFinite(x))))throw Error('Model returned an invalid force array.');
      const expectedBackend=plan.execution?.runtimeBackend==='webgpu'?'webgpu-':'cpu-wasm';
      if(!m.evaluationBackend?.startsWith(expectedBackend))throw Error('The force evaluation backend does not match the selected model. No fallback result was accepted.');
      records[m.displacementId]={forces,energy_ev:m.evaluation.energy_ev,stress_ev_per_a3:m.evaluation.stress_ev_per_a3,evaluationMs:m.evaluationMs,evaluationBackend:m.evaluationBackend,gpuTiming:m.gpuTiming||null};
      emit('checkpoint',{displacementId:m.displacementId,record:records[m.displacementId],completed:Object.keys(records).length,total:plan.displacements.length});next();
    }
  }catch(error){emit(m.type==='dos'?'dos-error':'error',{message:String(error.message||error)});}
};
