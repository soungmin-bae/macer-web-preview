self.window=self;importScripts('./elements.js?v=b58a19d099f6b3eb','./structures.js?v=65f1e3cb3d603895','./raman-parameters.js?v=93d893ddd7266225','./raman-core.js?v=1f2224583e1b43bc');
let cached=null;
self.onmessage=async({data:m})=>{
 const context={jobId:m.jobId,revision:m.revision,phononHash:m.phononHash,parameterHash:m.parameterHash};
 try{
  if(!Array.isArray(m.q)||m.q.length!==3||m.q.some(x=>!Number.isFinite(x)||Math.abs(x)>1e-8)||m.nacEnabled)throw Error('This preview requires analytic q=(0,0,0), without directional NAC.');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(RamanParameters.manifest))),parameterHash=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  if(parameterHash!==m.parameterHash)throw Error('Raman parameter hash mismatch.');
  if(m.parameterId!==RamanParameters.manifest.id)throw Error('Raman parameter identity mismatch.');
  let prepared,bands,memoryEstimate;
  if(m.reuseCached){
   if(!cached||cached.phononHash!==m.phononHash||cached.parameterHash!==m.parameterHash)throw Error('Cached Raman input identity mismatch; resend the complete phonon input.');
   ({prepared,bands,memoryEstimate}=cached);
  }else{
   if(!m.data||!Array.isArray(m.data.atoms)||!Array.isArray(m.bands)||m.bands.length!==3*m.data.atoms.length)throw Error('Invalid Gamma mode count or input structure.');
   const estimate=m.data.atoms.length*m.bands.length*3*2*32;if(estimate>RamanParameters.manifest.memoryLimitBytes)throw Error('Response work-array estimate exceeds 256 MiB.');
   prepared=RamanCore.prepare(m.data);bands=m.bands;memoryEstimate=estimate+prepared.pairs.length*512;if(memoryEstimate>RamanParameters.manifest.memoryLimitBytes)throw Error('Response work-array estimate exceeds 256 MiB.');
   cached={phononHash:m.phononHash,parameterHash:m.parameterHash,prepared,bands,memoryEstimate};
  }
  if(!Array.isArray(bands)||bands.length!==3*prepared.atoms.length||!Number.isInteger(m.startIndex)||m.startIndex<0||m.startIndex>bands.length)throw Error('Invalid Gamma mode count or resume index.');
  postMessage({...context,type:'prepared',pairCount:prepared.pairs.length,candidates:prepared.candidates,volume:prepared.volume,memoryEstimate,cached:!!m.reuseCached});
  let completed=[];
  // 32 modes keep each synchronous slice short while avoiding a timer and
  // main-thread refresh for every eight modes on ordinary primitive cells.
  const batchSize=32;
  for(let i=m.startIndex||0;i<bands.length;i++){
   // The analytic derivative is exercised against finite differences by the
   // regression suite; repeating two alpha evaluations for every mode at run
   // time adds cost without changing the response result.
   const result=RamanCore.mode(prepared,bands[i],i,1,false);
   completed.push({modeIndex:i,result});
   if(completed.length===batchSize||i+1===bands.length){
    postMessage({...context,type:'modes',results:completed});completed=[];
    // Yield between complete batches so cancellation and UI events stay responsive.
    await new Promise(resolve=>setTimeout(resolve,0));
   }
  }
  postMessage({...context,type:'finished'});
 }catch(error){postMessage({...context,type:'error',message:error.message||String(error)});}
};
