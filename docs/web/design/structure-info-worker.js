/* Local display-only symmetry, using the already bundled Moyo WASM. */
importScripts('./structures.js?v=dc2ff9d2e6b1d6d5','./structure-info-core.js?v=09f06d795bc0c3fb');
let modulePromise;
self.onmessage=async({data:m})=>{
 try{
  modulePromise||=(async()=>{const module=await import('./wasm-moyo/moyo_wasm.js?v=a5c1c5609f875497');await module.default();return module;})();
  const module=await modulePromise;
  postMessage({id:m.id,consumer:m.consumer,key:m.key,result:StructureInfoCore.analyze(m.structure,module,m.tolerance)});
 }catch(error){modulePromise=null;postMessage({id:m.id,consumer:m.consumer,key:m.key,error:error.message||'Local symmetry analysis failed.'});}
};
