self.window=self;
importScripts('./structures.js?v=65f1e3cb3d603895','./phonon-symmetry.js?v=e62c001460bf9be0','./phonon-nac.js?v=b29965ec12c1307f','./spectroscopy-tables.js?v=624d64c43265988a','./spectroscopy-core.js?v=c14dbef190215bdb','./born-student.js?v=17b6db3f8d6ed561','./born-student-runtime.js?v=729fd88804cb9d45','./born-environment.js?v=5a188760eb1d55ed','./born-environment-runtime.js?v=c5fdb043dcd71d27','./universal-ir-ct1-model.js?v=5bd586d79dbb650a','./universal-ir.js?v=9b950089b8cf4635');
let library,studentModel;
self.onmessage=async({data:m})=>{
 const context={jobId:m.jobId,revision:m.revision,inputHash:m.inputHash};
 try{
  if(m.nac||!Array.isArray(m.q)||m.q.some(x=>!Number.isFinite(x)||Math.abs(x)>1e-8))throw Error('Use analytic Gamma modes without directional NAC.');
  library||=(async()=>{const mod=await import('./wasm-moyo/moyo_wasm.js?v=a5c1c5609f875497');await mod.default();return mod;})();
  const moyo=await library;if(m.data.atoms.length*m.bands.length*3*2*32>256*1024*1024)throw Error('Gamma response estimate exceeds 256 MiB.');let symmetry,symmetryError;
  try{symmetry=SpectroscopyCore.analyze(m.data,m.bands,moyo);}catch(e){symmetryError=e.message;}
  let ir,irError;
  if(m.chargeInput)try{
   let input=m.chargeInput,bornPreparation,studentPrediction,universalPrediction,responseRoute;
   if(input.kind==='auto'){
    const runtime=BornEnvironmentRuntime;if(!runtime)throw Error('Auto IR could not find the declared local Born model runtime.');
    if(!Array.isArray(runtime.supportedAtomicNumbers))throw Error('Auto IR model coverage manifest is missing; no fallback was attempted.');
    const unsupported=[...new Set(m.data.atoms.map(a=>a.element).filter(element=>!runtime.supportedAtomicNumbers.includes(Structures.atomicNumber(element))))].sort();
    if(unsupported.length){
     const expected=UniversalIRCT1Model.parameterSHA256;
     if(input.parameterSHA256&&input.parameterSHA256!==expected)throw Error('Auto IR universal parameter identity mismatch.');
     universalPrediction=UniversalIR.predict(m.data);
     input={kind:'born',values:universalPrediction.tensors};
     responseRoute={requestedPath:'Auto',actualPath:'Universal CT1 estimated dynamic charges',reason:'The DFT-trained Born model has no declared element coverage for '+unsupported.join(', ')+'.',qualification:'UNQUALIFIED_APPROXIMATION',displayQualification:'Unqualified approximation; absolute IR-strength gate failed.',modelId:universalPrediction.modelId,parameterSHA256:universalPrediction.parameterSHA256,unsupportedElements:unsupported,diagnostics:universalPrediction.diagnostics};
    }else{
     studentModel||=BornStudent.load(runtime);const model=await studentModel;
     if(unsupported.length||m.data.atoms.some(a=>!model.supportedAtomicNumbers.includes(Structures.atomicNumber(a.element))))throw Error('Auto IR species coverage does not match the verified model artifact; no fallback was attempted.');
     studentPrediction=BornEnvironment.predict(m.data,model);studentPrediction.modelSHA256=runtime.sha256;
     input={kind:'born',values:studentPrediction.tensors};
     responseRoute={requestedPath:'Auto',actualPath:'Environment Born model estimate · DFT-trained pilot',reason:'All input elements are in the model’s declared element coverage. Coverage does not establish accuracy for this material.',qualification:'EXPERIMENTAL_FIXTURE_SCREENING_ONLY',displayQualification:'Pilot model; quantitative accuracy for this material is not established.',modelId:studentPrediction.modelId,modelSHA256:runtime.sha256};
    }
   }
   if(input.kind==='universal'){
    const expected=UniversalIRCT1Model.parameterSHA256;
    if(input.parameterSHA256&&input.parameterSHA256!==expected)throw Error('Universal IR parameter identity mismatch.');
    universalPrediction=UniversalIR.predict(m.data);
    input={kind:'born',values:universalPrediction.tensors};
    responseRoute={requestedPath:'Universal CT1',actualPath:'Universal CT1 estimated dynamic charges',reason:'Explicit user-selected fallback path.',qualification:'UNQUALIFIED_APPROXIMATION',displayQualification:'Unqualified approximation; absolute IR-strength gate failed.',modelId:universalPrediction.modelId,parameterSHA256:universalPrediction.parameterSHA256,diagnostics:universalPrediction.diagnostics};
   }
   if(input.kind==='student'){
    const runtime=input.modelSHA256===BornEnvironmentRuntime.sha256?BornEnvironmentRuntime:input.modelSHA256===BornStudentRuntime.sha256?BornStudentRuntime:null;
    if(!runtime)throw Error('Small Born model identity mismatch.');
    studentModel||=BornStudent.load(runtime);const model=await studentModel;studentPrediction=model.schema==='macer-small-born-environment-v2'?BornEnvironment.predict(m.data,model):BornStudent.predict(m.data,model);
    studentPrediction.modelSHA256=runtime.sha256;
    const source=studentPrediction.modelId.includes('two-hop')?'Environment Born model estimate · DFT-trained pilot':'Small Born model estimate · DFT-trained pilot';
    responseRoute={requestedPath:'DFT-trained Born model',actualPath:source,reason:'Explicitly selected pilot model. Element coverage does not establish accuracy for this material.',qualification:'EXPERIMENTAL_FIXTURE_SCREENING_ONLY',displayQualification:'Pilot model; quantitative accuracy for this material is not established.',modelId:studentPrediction.modelId,modelSHA256:runtime.sha256};
    input={kind:'born',values:studentPrediction.tensors};
   }
   if(input.kind==='born-file'){
    if(!symmetry)throw Error('BORN symmetry expansion requires a valid primitive symmetry analysis.');
    bornPreparation=PhononNac.parse(input.text,SpectroscopyCore.geometry(m.data),symmetry.mapping);
    responseRoute={requestedPath:'Phonopy BORN file',actualPath:'Supplied Born tensors · symmetry-expanded',reason:'The input file was mapped to this structure; its source accuracy was not independently checked.',qualification:'SUPPLIED_INPUT_NOT_INDEPENDENTLY_VALIDATED',displayQualification:'Supplied data; source accuracy is not independently checked.'};
    input={kind:'born',values:bornPreparation.born};
   }
   if(!responseRoute&&input.kind==='born')responseRoute={requestedPath:'Supplied Born tensors',actualPath:'User-supplied Born tensors',reason:'Tensor values were accepted for the current structure; their scientific provenance was not independently checked.',qualification:'SUPPLIED_INPUT_NOT_INDEPENDENTLY_VALIDATED',displayQualification:'Supplied data; source accuracy is not independently checked.'};
   if(!responseRoute&&input.kind==='nominal')responseRoute={requestedPath:'Nominal charges',actualPath:'User-supplied nominal-charge estimate',reason:'Explicit heuristic charges were selected; nominal charges are not dynamical Born tensors.',qualification:'UNQUALIFIED_APPROXIMATION',displayQualification:'Unqualified heuristic estimate; not a Born-tensor prediction.'};
   ir=SpectroscopyCore.infrared(m.data,m.bands,input);if(bornPreparation)ir.bornPreparation=bornPreparation;if(studentPrediction){ir.source=studentPrediction.modelId.includes('two-hop')?'Environment Born model estimate · DFT-trained pilot':'Small Born model estimate · DFT-trained pilot';ir.prediction={...studentPrediction};}if(universalPrediction){ir.source=universalPrediction.source;ir.prediction=universalPrediction;}if(responseRoute)ir.responseRoute=responseRoute;
   if(symmetry){let residual=0;const maps=symmetry.mapping;maps.forwardAtomPermutations.forEach((p,op)=>{const r=maps.rotationsCartesian[op];for(let i=0;i<p.length;i++)for(let a=0;a<3;a++)for(let b=0;b<3;b++){let z=0;for(let k=0;k<3;k++)for(let l=0;l<3;l++)z+=r[3*a+k]*ir.tensors[i][3*k+l]*r[3*b+l];residual=Math.max(residual,Math.abs(z-ir.tensors[p[i]][3*a+b]));}});ir.chargeSymmetryResidual=residual;ir.selectionRulesConsistent=residual<=1e-6;}
  }catch(e){irError=e.message;}
  if(symmetry)delete symmetry.mapping;
  postMessage({...context,type:'finished',symmetry,symmetryError,ir,irError});
 }catch(e){postMessage({...context,type:'error',message:e.message});}
};
