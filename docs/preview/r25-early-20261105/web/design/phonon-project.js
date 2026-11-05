/* Project compatibility and hydrostatic pressure metadata; no model execution. */
(function(root){
  const copy=x=>JSON.parse(JSON.stringify(x));
  function pressure(value){if(value===''||value===null||!Number.isFinite(Number(value)))throw Error('External pressure must be a finite number in GPa.');return Number(value);}
  function validateNacPrerequisites(settings){
    if(settings?.nacEnabled&&settings.nacResponse==='predict'&&settings.skipRelax)
      throw Error('Predicted NAC requires a successful initial Relax. Turn off Skip initial relaxation or choose Upload BORN.');
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
    pressure(p.settings.pressureGpa);return p;
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
  root.PhononProject={pressure,hash,migrate,resolveModel,summary,sameResponseRuntime,validateNacPrerequisites};
})(globalThis);
