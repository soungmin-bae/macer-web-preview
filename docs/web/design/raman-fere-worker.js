/* Client-only worker for the frozen FERE Raman tensor candidate. */
self.window=self;
importScripts('./elements.js','./structures.js','./raman-fere-model.js','./raman-fere-core.js');
let cached=null;
const hex=bytes=>[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
self.onmessage=async({data:m})=>{
 const context={jobId:m.jobId,revision:m.revision,phononHash:m.phononHash,parameterHash:m.parameterHash};
 try{
  const model=RamanFEREBundle;
  if(!Array.isArray(m.q)||m.q.length!==3||m.q.some(x=>!Number.isFinite(x)||Math.abs(x)>1e-8)||m.nacEnabled)throw Error('FERE Raman requires analytic q=(0,0,0) modes without directional NAC.');
  const digest=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(model))));
  if(digest!==m.parameterHash||m.parameterId!==model.id)throw Error('FERE Raman model identity mismatch.');
  let prepared,bands,memoryEstimate;
  if(m.reuseCached){
   if(!cached||cached.phononHash!==m.phononHash||cached.parameterHash!==m.parameterHash)throw Error('Cached FERE Raman input identity mismatch; resend the complete phonon input.');
   ({prepared,bands,memoryEstimate}=cached);
  }else{
   if(!m.data||!Array.isArray(m.data.atoms)||!Array.isArray(m.bands)||m.bands.length!==3*m.data.atoms.length)throw Error('Invalid FERE Γ modes or structure.');
   const estimate=m.data.atoms.length*m.bands.length*3*2*8;
   if(estimate>256*1024*1024)throw Error('FERE Raman work-array estimate exceeds 256 MiB.');
   prepared=RamanFERECore.prepare(m.data);bands=m.bands;memoryEstimate=estimate+prepared.bonds.length*320;
   if(memoryEstimate>256*1024*1024)throw Error('FERE Raman work-array estimate exceeds 256 MiB.');
   cached={phononHash:m.phononHash,parameterHash:m.parameterHash,prepared,bands,memoryEstimate};
  }
  postMessage({...context,type:'prepared',bondCount:prepared.bonds.length,candidates:prepared.candidatesVisited,volume:prepared.volume,memoryEstimate,diagnostics:prepared.diagnostics});
  if(!Number.isInteger(m.startIndex)||m.startIndex<0||m.startIndex>bands.length)throw Error('Invalid FERE resume index.');
  let completed=[];
  for(let i=m.startIndex;i<bands.length;i++){
   completed.push({modeIndex:i,result:RamanFERECore.mode(prepared,bands[i],i)});
   if(completed.length===16||i+1===bands.length){postMessage({...context,type:'modes',results:completed});completed=[];await new Promise(resolve=>setTimeout(resolve,0));}
  }
  postMessage({...context,type:'finished'});
 }catch(error){postMessage({...context,type:'error',message:error.message||String(error)});}
};
