/* Experimental relative powder profile. No absolute Raman tensor is fabricated. */
self.window=self;importScripts('./elements.js?v=b58a19d099f6b3eb','./structures.js?v=65f1e3cb3d603895','./raman-parameters.js?v=93d893ddd7266225','./raman-core.js?v=1f2224583e1b43bc','./raman-dft-runtime.js?v=105bc9bef4801720','./raman-dft-profile.js?v=176c33736c94aae3');
self.onmessage=async({data:m})=>{const context={jobId:m.jobId,revision:m.revision,phononHash:m.phononHash,parameterHash:m.parameterHash};try{
 if(m.nacEnabled||m.q?.length!==3||m.q.some(x=>!Number.isFinite(x)||Math.abs(x)>1e-8))throw Error('Analytic Gamma modes without directional NAC are required.');
 if(m.bands?.length!==3*m.data.atoms.length||!Number.isInteger(m.startIndex)||m.startIndex<0||m.startIndex>m.bands.length)throw Error('Invalid Gamma modes or resume index.');
 const h=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(RamanDFTRuntime))))].map(x=>x.toString(16).padStart(2,'0')).join('');if(h!==m.parameterHash||m.parameterId!==RamanDFTRuntime.id)throw Error('DFT Raman model identity mismatch.');
 const estimate=m.bands.length*m.data.atoms.length*3*16*16+m.bands.length*16*18*8;if(estimate>256*1024*1024)throw Error('Raman work-array estimate exceeds 256 MiB.');
 const model=await RamanDFTProfile.load(RamanDFTRuntime),result=RamanDFTProfile.predict(m.data,m.bands,model);
 postMessage({...context,type:'prepared',volume:Math.abs(Structures.determinant(m.data.lattice)),memoryEstimate:estimate,diagnostics:result.diagnostics,relativeOnly:true});
 for(let i=m.startIndex;i<result.modes.length;i++)postMessage({...context,type:'mode',modeIndex:i,result:result.modes[i]});
 postMessage({...context,type:'finished'});
 }catch(e){postMessage({...context,type:'error',message:e.message||String(e)});}};
