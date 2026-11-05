(function(root){
'use strict';
let worker=null,sequence=0;
const pending=new Map(),timers=new Map(),last=new Map();
const points=[[2,'1'],[3,'-1'],[6,'2'],[10,'m'],[16,'2/m'],[25,'222'],[47,'mm2'],[75,'mmm'],[81,'4'],[83,'-4'],[89,'4/m'],[99,'422'],[111,'4mm'],[123,'-42m'],[143,'4/mmm'],[147,'3'],[149,'-3'],[156,'32'],[162,'3m'],[168,'-3m'],[174,'6'],[175,'-6'],[177,'6/m'],[183,'622'],[187,'6mm'],[191,'-6m2'],[195,'6/mmm'],[200,'23'],[207,'m-3'],[215,'432'],[221,'-43m'],[231,'m-3m']];

function changed(consumer){
  document.dispatchEvent(new CustomEvent('macer-input-symmetry-change',{detail:{consumer}}));
}
function summary(result){
  const number=result.spaceGroupNumber;
  const system=number<=2?'Triclinic':number<=15?'Monoclinic':number<=74?'Orthorhombic':number<=142?'Tetragonal':number<=167?'Trigonal':number<=194?'Hexagonal':'Cubic';
  return `Local symmetry: ${result.spaceGroupSymbol} (No. ${number}) · ${points.find(([upper])=>number<upper)?.[1]||'—'} · ${system} · primitive ${result.primitiveAtoms} atoms`;
}
function element(consumer){
  const id=consumer+'-input-symmetry';
  let status=document.getElementById(id);
  if(!status){
    status=document.createElement('div');status.id=id;status.className='input-symmetry';status.setAttribute('role','status');
    document.getElementById(consumer==='relax'?'input-note':'phonon-input-state').after(status);
    const tools=document.createElement('span');
    for(const [label,key] of [['Use primitive cell','primitive'],['Use conventional cell','standard']]){
      const button=document.createElement('button');button.type='button';button.textContent=label;button.style.marginLeft='6px';button.onclick=()=>convert(consumer,key);tools.append(button);
    }
    status.after(tools);
  }
  return status;
}
function startWorker(){
  if(worker)return worker;
  worker=new Worker('./input-symmetry-worker.js?v=143d9784182d7c92');
  worker.onmessage=({data:message})=>{
    const request=pending.get(message.consumer);
    if(!request||request.requestId!==message.requestId||request.structureHash!==message.structureHash)return;
    const status=element(message.consumer);
    if(message.type==='error'){
      delete status.dataset.symmetryPayload;
      status.textContent='Local symmetry unavailable: '+message.message;
      changed(message.consumer);
      return;
    }
    last.set(message.consumer,message);
    const mapping=message.result?.mapping;
    if(mapping){
      status.dataset.symmetryPayload=JSON.stringify({revision:message.revision,structureHash:message.structureHash,spaceGroupNumber:message.result.spaceGroupNumber,
        mapping:{rotationsCartesian:mapping.rotationsCartesian,forwardAtomPermutations:mapping.forwardAtomPermutations}});
    }else delete status.dataset.symmetryPayload;
    status.textContent=summary(message.result);
    changed(message.consumer);
  };
  worker.onerror=()=>{
    for(const consumer of pending.keys()){
      element(consumer).textContent='Local symmetry analysis failed. Edit the structure to retry.';
      changed(consumer);
    }
    worker?.terminate();worker=null;
  };
  return worker;
}
async function analyze(consumer,structure,revision,requestId){
  const bytes=new TextEncoder().encode(JSON.stringify([structure.cell,structure.atoms.map(atom=>[atom.element,atom.position]),1e-4]));
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
  if(pending.get(consumer)?.requestId!==requestId)return;
  pending.set(consumer,{requestId,structureHash:hash});
  startWorker().postMessage({consumer,structure,revision,requestId,structureHash:hash,symprec:1e-4});
}
function convert(consumer,kind){
  const message=last.get(consumer),host=consumer==='relax'?root.MacerRelax:root.PhononJob;
  if(!message||host.busy())return;
  try{
    const cell=kind==='primitive'?message.result.dataset.prim_std_cell:message.result.dataset.std_cell;
    if(!cell)throw Error('The standardized cell is unavailable.');
    const structure={cell:[0,1,2].map(index=>cell.lattice.basis.slice(index*3,index*3+3)),pbc:[true,true,true],
      atoms:cell.numbers.map((number,index)=>({element:root.Structures.elementSymbol(number),position:root.Structures.cartesian(cell.positions[index],[0,1,2].map(axis=>cell.lattice.basis.slice(axis*3,axis*3+3))),mask:[true,true,true]})),
      comment:'Explicit '+kind+' cell conversion'};
    const provenance=host.inputStructure?.()?.provenance;
    host.useStructure(structure,provenance?{...provenance,modified:true}:null);
  }catch(error){element(consumer).textContent=error.message;changed(consumer);}
}
function schedule(consumer,structure,revision){
  clearTimeout(timers.get(consumer));
  const requestId=++sequence;
  pending.set(consumer,{requestId});last.delete(consumer);
  const status=element(consumer);
  status.dataset.symmetryRevision=String(revision);
  delete status.dataset.symmetryPayload;
  if(!structure?.cell||!structure?.pbc?.every(Boolean)){
    status.textContent='Local symmetry: not applicable to a nonperiodic structure.';
    changed(consumer);
    return;
  }
  status.textContent='Analyzing local symmetry…';
  changed(consumer);
  timers.set(consumer,setTimeout(()=>analyze(consumer,structure,revision,requestId).catch(error=>{
    if(pending.get(consumer)?.requestId===requestId){status.textContent=error.message;changed(consumer);}
  }),300));
}
root.InputSymmetry={
  schedule,
  get(consumer){
    const serialized=element(consumer).dataset.symmetryPayload;
    if(!serialized)return null;
    try{const payload=JSON.parse(serialized);return {revision:payload.revision,structureHash:payload.structureHash,result:{spaceGroupNumber:payload.spaceGroupNumber,mapping:payload.mapping}};}
    catch{return null;}
  },
  summary,
};
})(globalThis);
