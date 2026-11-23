/* Project compatibility and hydrostatic pressure metadata; no model execution. */
(function(root){
  const copy=x=>JSON.parse(JSON.stringify(x));
  function pressure(value){if(value===''||value===null||!Number.isFinite(Number(value)))throw Error('External pressure must be a finite number in GPa.');return Number(value);}
  function validateNacPrerequisites(settings){
    return true;
  }
  async function hash(input,settings,modelKey){return Array.from(new Uint8Array(await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({input,settings,modelKey}))))).map(x=>x.toString(16).padStart(2,'0')).join('');}
  async function migrate(original){
    const p=copy(original);
    if(await hash(p.preparedInput,p.settings,p.modelKey)!==p.configurationHash)throw Error('Project structure/settings/model hash does not match.');
    if(!Object.hasOwn(p.settings,'pressureGpa')){
      p.migrations=[...(p.migrations||[]),{from:'pressure-absent',pressureGpa:0,originalConfigurationHash:p.configurationHash}];
      p.settings.pressureGpa=0;p.configurationHash=await hash(p.preparedInput,p.settings,p.modelKey);
    }
    if(Object.hasOwn(p.settings,'relaxOptimizer')&&!['fire','lbfgs','cg'].includes(p.settings.relaxOptimizer)){
      throw Error('Invalid initial relaxation optimizer in project.');
    }
    pressure(p.settings.pressureGpa);return p;
  }
  function persistCheckpoint(payload,storage=root.indexedDB){
    return new Promise((resolve,reject)=>{
      let settled=false;const finish=error=>{if(settled)return;settled=true;error?reject(error):resolve();};
      const request=storage.open('macer-phonon-preview',1);
      request.onerror=()=>finish(request.error||new Error('Could not open recovery storage.'));
      request.onblocked=()=>finish(new Error('Recovery storage is blocked by another tab.'));
      request.onupgradeneeded=()=>{if(settled){request.transaction.abort();return;}if(!request.result.objectStoreNames.contains('projects'))request.result.createObjectStore('projects');};
      request.onsuccess=()=>{
        const db=request.result;if(settled){db.close();return;}db.onversionchange=()=>db.close();
        try{
          const tx=db.transaction('projects','readwrite');
          tx.oncomplete=()=>{db.close();finish();};
          tx.onabort=()=>{db.close();finish(tx.error||new Error('Recovery checkpoint transaction aborted.'));};
          tx.objectStore('projects').put(payload,'latest');
        }catch(error){db.close();finish(error);}
      };
    });
  }
  // One in-flight transaction and one replaceable pending reference. Capture
  // at request time so editing/replacing the active job cannot lose its save.
  function createCheckpointWriter({persist=persistCheckpoint,onState=()=>{}}={}){
    let requested=0,persisted=0,running=null,lastError=null,pending=null;
    async function drain(){
      while(persisted<requested){
        const version=requested,payload=pending;pending=null;
        try{
          const records=Object.keys(payload.records||{}).length;
          await persist(payload);persisted=version;
          onState({state:persisted<requested?'saving':'saved',version,persisted,records});
        }catch(error){lastError=error;onState({state:'error',version,persisted,error});return;}
      }
    }
    function start(){running=Promise.resolve().then(drain).finally(()=>{running=null;if(persisted<requested&&!lastError)start();});}
    return {
      request(payload){pending=payload;requested++;lastError=null;onState({state:'saving',version:requested,persisted});if(!running)start();},
      async flush(){while(running)await running;if(lastError)throw lastError;},
    };
  }
  function resolveModel(catalog,modelKey){
    const current=catalog?.models?.find(model=>model.model_key===modelKey);
    if(current)return {model:current,kind:'current'};
    const compatible=catalog?.compatibility_models?.find(model=>model.model_key===modelKey);
    if(compatible)return {model:compatible,kind:'compatibility'};
    return null;
  }
  function summary(settings,snapshot){
    const applied=!settings.skipRelax,stress=snapshot?.evaluation?.stress_ev_per_a3;
    return {requestedPressureGpa:settings.pressureGpa??0,appliedPressureGpa:applied?(settings.pressureGpa??0):null,
      initialRelaxationSkipped:!applied,finalInternalPressureGpa:applied&&stress?-(stress[0][0]+stress[1][1]+stress[2][2])/3*160.21766208:null,
      stressResidualGpa:applied?snapshot?.max_stress_residual_gpa??null:null};
  }
  // Presentation modules are not calculation identities; retain numerical and model hashes.
  function sameResponseRuntime(a,b){
    const scientific=value=>{
      if(value==null)return null;
      const r=copy(value);delete r.spectrumView;
      if(r.files){delete r.files['raman-preview.js'];delete r.files['spectroscopy-preview.js'];}
      return r;
    };
    const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
    return JSON.stringify(canonical(scientific(a)))===JSON.stringify(canonical(scientific(b)));
  }
  function responseIdentityMatches(actual,expected){
    if(!actual||!expected)return false;
    return actual.phononHash===expected.phononHash&&actual.parameterHash===expected.parameterHash&&
      actual.kernel===expected.kernel&&actual.candidateId===expected.candidateId&&
      sameResponseRuntime(actual.runtimeHashes,expected.runtimeHashes);
  }
  root.PhononProject={persistCheckpoint,createCheckpointWriter,pressure,hash,migrate,resolveModel,summary,sameResponseRuntime,responseIdentityMatches,validateNacPrerequisites};
})(globalThis);
