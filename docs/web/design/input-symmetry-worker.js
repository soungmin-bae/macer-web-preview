/* One analysis worker shared by both workspaces. No model or remote query. */
self.window=self;
importScripts('./elements.js?v=b58a19d099f6b3eb','./structures.js?v=dc2ff9d2e6b1d6d5','./phonon-symmetry.js?v=153e9aeb21fb5b11');
const cache=new Map();
onmessage=async({data:m})=>{
 try{const key=JSON.stringify([m.structure.cell,m.structure.atoms.map(a=>[a.element,a.position]),m.symprec||1e-4]);let result=cache.get(key);
 if(!result){result=await PhononSymmetry.analyzeStructure(m.structure,{tolerance:m.symprec||1e-4});cache.set(key,result);while(cache.size>20)cache.delete(cache.keys().next().value);}
 postMessage({type:'result',consumer:m.consumer,revision:m.revision,requestId:m.requestId,structureHash:m.structureHash,result});
 }catch(e){postMessage({type:'error',consumer:m.consumer,revision:m.revision,requestId:m.requestId,structureHash:m.structureHash,message:e.message});}
};
