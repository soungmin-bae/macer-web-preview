/* Symmetry-owned conventional axes and fixed-basis directional phonon strains.
   Gamma for a tied group is normalized per direction (ab is divided by two). */
(function(root){
'use strict';
const I=()=>[[1,0,0],[0,1,0],[0,0,1]];
const transpose=a=>a[0].map((_,j)=>a.map(r=>r[j]));
const mul=(a,b)=>a.map(r=>b[0].map((_,j)=>r.reduce((s,x,k)=>s+x*b[k][j],0)));
const vector=(v,d)=>d[0].map((_,j)=>v.reduce((s,x,k)=>s+x*d[k][j],0));
const determinant=a=>a[0][0]*(a[1][1]*a[2][2]-a[1][2]*a[2][1])-a[0][1]*(a[1][0]*a[2][2]-a[1][2]*a[2][0])+a[0][2]*(a[1][0]*a[2][1]-a[1][1]*a[2][0]);
function inverse(a){const d=determinant(a);if(!Number.isFinite(d)||Math.abs(d)<1e-12)throw Error('Singular lattice transformation.');return transpose(a.map((_,i)=>[0,1,2].map(j=>(a[(i+1)%3][(j+1)%3]*a[(i+2)%3][(j+2)%3]-a[(i+1)%3][(j+2)%3]*a[(i+2)%3][(j+1)%3])/d)));}
const residual=(a,b)=>Math.max(...a.flat().map((x,i)=>Math.abs(x-b.flat()[i])));
function classify(number){
 if(!Number.isInteger(number)||number<1||number>230)return {system:'unknown',groups:[],reason:'Space-group identification is unavailable.'};
 if(number<=15)return {system:number<=2?'triclinic':'monoclinic',groups:[],reason:'Angle strains are not supported; using isotropic γ(V).'};
 if(number>=195)return {system:'cubic',groups:[],reason:'Cubic symmetry ties all three directions; using isotropic γ(V).'};
 if(number<=74)return {system:'orthorhombic',groups:['a','b','c'].map((id,i)=>({id,label:'γ'+id,axes:[i],multiplicity:1}))};
 return {system:number<=142?'tetragonal':number<=167?'trigonal':'hexagonal',groups:[{id:'ab',label:'γab',axes:[0,1],multiplicity:2},{id:'c',label:'γc',axes:[2],multiplicity:1}]};
}
function describe(primitive,dataset,symprec=1e-5){
 const info={schema:'macer-directional-basis-v1',spaceGroup:dataset?.number,symbol:dataset?.hm_symbol||'',symprec,...classify(dataset?.number),supported:false};
 if(!info.groups.length)return info;
 try{
  const standard=dataset.std_cell;
  if(!standard?.lattice?.basis||!standard.positions?.length)throw Error('Standard conventional cell is unavailable.');
  const conventionalCell=[0,1,2].map(i=>standard.lattice.basis.slice(i*3,i*3+3));
  const matrix=mul(conventionalCell,inverse(primitive.cell)),rounded=matrix.map(r=>r.map(Math.round));
  const multiplicity=standard.numbers.length/primitive.atoms.length;
  if(!Number.isInteger(multiplicity)||residual(matrix,rounded)>1e-6||Math.abs(Math.abs(determinant(rounded))-multiplicity)>1e-6||residual(mul(rounded,primitive.cell),conventionalCell)>symprec*2)throw Error('Primitive / conventional lattice mapping failed.');
  const lengths=conventionalCell.map(r=>Math.hypot(...r));
  const cos=(i,j)=>conventionalCell[i].reduce((s,x,k)=>s+x*conventionalCell[j][k],0)/(lengths[i]*lengths[j]);
  const hex=info.system==='hexagonal'||info.system==='trigonal';
  if(Math.abs(cos(0,2))>1e-6||Math.abs(cos(1,2))>1e-6||Math.abs(cos(0,1)-(hex?-.5:0))>1e-6)throw Error('Standard axis setting is not supported.');
  if(info.system!=='orthorhombic'&&Math.abs(lengths[0]-lengths[1])>symprec*2)throw Error('Symmetry-tied a and b lengths do not agree.');
  const counts=primitive.atoms.map(()=>0);
  for(let i=0;i<standard.positions.length;i++){
   const p=root.Structures.cartesian(standard.positions[i],conventionalCell),f=root.Structures.fractional(p,primitive.cell);
   const candidates=primitive.atoms.map((a,j)=>{
    if(root.Structures.atomicNumber(a.element)!==standard.numbers[i])return -1;
    const af=root.Structures.fractional(a.position,primitive.cell),df=f.map((x,k)=>x-af[k]-Math.round(x-af[k]));
    return Math.hypot(...root.Structures.cartesian(df,primitive.cell))<=symprec*2?j:-1;
   }).filter(j=>j>=0);
   if(candidates.length!==1)throw Error('Conventional atom sites do not map uniquely to the primitive cell.');counts[candidates[0]]++;
  }
  if(counts.some(n=>n!==multiplicity))throw Error('Conventional site multiplicity failed.');
  return {...info,supported:true,reason:'Standard conventional axes verified; primitive atom order is retained.',conventionalCell,primitiveToConventional:rounded,conventionalMultiplicity:multiplicity,primitiveAtoms:primitive.atoms.length,conventionalAtoms:standard.numbers.length,lengths};
 }catch(error){return {...info,groups:[],reason:error.message+' Using isotropic γ(V).'};}
}
function deformation(basis,groupId,factor){
 const group=basis.supported&&basis.groups.find(g=>g.id===groupId);
 if(!group||!Number.isFinite(factor)||factor<=0)throw Error('Unsupported directional strain.');
 const target=basis.conventionalCell.map((r,i)=>r.map(x=>x*(group.axes.includes(i)?factor:1)));
 return mul(inverse(basis.conventionalCell),target);
}
function deformPlan(reference,d,geometry){
 if(!Array.isArray(d)||d.length!==3||d.some(r=>r.length!==3||r.some(x=>!Number.isFinite(x)))||determinant(d)<=0)throw Error('Invalid positive strain deformation.');
 const dt=transpose(d);
 for(const flat of reference.mapping.rotationsCartesian){
  const r=[flat.slice(0,3),flat.slice(3,6),flat.slice(6,9)];
  if(residual(mul(dt,r),mul(r,dt))>1e-7)throw Error('The strain does not preserve the reference symmetry.');
 }
 const positions=reference.primitive.atoms.map(a=>vector(a.position,d));
 const deltas=positions.map((p,i)=>p.map((x,k)=>(geometry?.positions_a[i][k]??x)-x));
 // The displacement expansion is reused only if internal relaxation retains
 // every reference operation, modulo one common rigid translation per operation.
 for(const [op,perm] of reference.mapping.forwardAtomPermutations.entries()){
  const flat=reference.mapping.rotationsCartesian[op];
  const offsets=perm.map((j,i)=>{
   const dv=deltas[reference.primitiveIndices[i]],rot=[0,1,2].map(k=>dv.reduce((s,x,l)=>s+x*flat[3*k+l],0));
   return deltas[reference.primitiveIndices[j]].map((x,k)=>x-rot[k]);
  });
  if(offsets.some(v=>Math.hypot(...v.map((x,k)=>x-offsets[0][k]))>reference.settings.symprec*2))throw Error('Internal relaxation changed the reference symmetry. Directional result withheld.');
 }
 const primitiveCell=mul(reference.primitive.cell,d);
 if(geometry&&residual(primitiveCell,geometry.cell_a)>1e-9)throw Error('Directional fixed lattice changed.');
 return {...reference,nac:null,primitive:{...reference.primitive,cell:primitiveCell,atoms:reference.primitive.atoms.map((a,i)=>({...a,position:positions[i].map((x,k)=>x+deltas[i][k])}))},supercell:{...reference.supercell,cell:mul(reference.supercell.cell,d),atoms:reference.supercell.atoms.map((a,i)=>({...a,position:vector(a.position,d).map((x,k)=>x+deltas[reference.primitiveIndices[i]][k])}))}};
}
function estimatedModeBytes(atoms,qpoints,groups){return 144*atoms*atoms*qpoints*(groups+1)*4;}
root.PhononDirectional={estimatedModeBytes,classify,describe,deformation,deformPlan,mul,inverse,determinant,vector,identity:I};
if(typeof module==='object'&&module.exports)module.exports=root.PhononDirectional;
})(globalThis);
