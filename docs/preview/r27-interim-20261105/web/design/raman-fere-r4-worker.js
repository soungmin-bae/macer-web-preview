/* Client-only worker for an opt-in, explicitly experimental FERE R4 preview. */
self.window=self;
importScripts('./elements.js?v=b58a19d099f6b3eb','./structures.js?v=65f1e3cb3d603895','./raman-fere-r4-model.js?v=95bc3b31112c2ae2','./raman-fere-r4-core.js?v=710c4bb306666bc2');
let cached=null;
const hex=bytes=>[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
self.onmessage=async({data:m})=>{
 const context={jobId:m.jobId,revision:m.revision,phononHash:m.phononHash,parameterHash:m.parameterHash};
 try{
  const model=RamanFEREPreviewBundle;
  if(!Array.isArray(m.q)||m.q.length!==3||m.q.some(x=>!Number.isFinite(x)||Math.abs(x)>1e-8)||m.nacEnabled)throw Error('FERE R4 preview requires analytic q=(0,0,0) modes without directional NAC.');
  const digest=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(model))));
  if(digest!==m.parameterHash||m.parameterId!==model.id||model.qualification!=='EXPLORATORY_PREVIEW_ONLY')throw Error('Experimental FERE R4 model identity mismatch.');
  let prepared,bands,memoryEstimate;
  if(m.reuseCached){if(!cached||cached.phononHash!==m.phononHash||cached.parameterHash!==m.parameterHash)throw Error('Cached FERE R4 identity mismatch; resend complete phonon input.');({prepared,bands,memoryEstimate}=cached);}
  else{
   if(!m.data||!Array.isArray(m.data.atoms)||!Array.isArray(m.bands)||m.bands.length!==3*m.data.atoms.length)throw Error('Invalid FERE R4 Γ modes or structure.');
   const estimate=m.data.atoms.length*m.bands.length*3*2*8;if(estimate>256*1024*1024)throw Error('FERE R4 work-array estimate exceeds 256 MiB.');
   prepared=RamanFEREPreviewCore.prepare(m.data);bands=m.bands;memoryEstimate=estimate+prepared.bonds.length*448;if(memoryEstimate>256*1024*1024)throw Error('FERE R4 work-array estimate exceeds 256 MiB.');cached={phononHash:m.phononHash,parameterHash:m.parameterHash,prepared,bands,memoryEstimate};
  }
  postMessage({...context,type:'prepared',bondCount:prepared.bonds.length,candidates:prepared.candidatesVisited,volume:prepared.volume,memoryEstimate,diagnostics:prepared.diagnostics,qualification:model.qualification});
  if(!Number.isInteger(m.startIndex)||m.startIndex<0||m.startIndex>bands.length)throw Error('Invalid FERE R4 resume index.');
  let completed=[];for(let i=m.startIndex;i<bands.length;i++){completed.push({modeIndex:i,result:RamanFEREPreviewCore.mode(prepared,bands[i],i)});if(completed.length===16||i+1===bands.length){postMessage({...context,type:'modes',results:completed});completed=[];await new Promise(resolve=>setTimeout(resolve,0));}}
  postMessage({...context,type:'finished'});
 }catch(error){postMessage({...context,type:'error',message:error.message||String(error)});}
};
