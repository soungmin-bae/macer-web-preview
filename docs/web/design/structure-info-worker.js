/* Local display-only symmetry, using the already bundled Moyo WASM. */
importScripts('./structures.js?v=65f1e3cb3d603895','./structure-info-core.js?v=1317ebff66ccc2f0');
let modulePromise;
self.onmessage=async({data:m})=>{
 try{
  modulePromise||=(async()=>{const module=await import('./wasm-moyo/moyo_wasm.js?v=d407370cc1aaf35f');await module.default();return module;})();
  const module=await modulePromise;
  postMessage({id:m.id,consumer:m.consumer,key:m.key,result:StructureInfoCore.analyze(m.structure,module,m.tolerance)});
 }catch(error){modulePromise=null;postMessage({id:m.id,consumer:m.consumer,key:m.key,error:error.message||'Local symmetry analysis failed.'});}
};
