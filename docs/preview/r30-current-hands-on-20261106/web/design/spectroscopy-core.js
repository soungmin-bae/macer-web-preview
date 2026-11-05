/* Float64 Gamma representations and coherent mode effective charges. */
(function(root){'use strict';
const S=root.Structures,PS=root.PhononSymmetry,T=root.SpectroscopyTables;
const rows=a=>[0,1,2].map(i=>[0,1,2].map(j=>a[3*j+i]));
const mm=(a,b)=>a.map(r=>b[0].map((_,j)=>r.reduce((v,x,k)=>v+x*b[k][j],0)));
const inv=a=>{const c=a[0].map((_,j)=>a.map(r=>r[j]));const columns=[0,1,2].map(i=>S.fractional([+(i===0),+(i===1),+(i===2)],c));return columns[0].map((_,i)=>columns.map(v=>v[i]));};
const trace=a=>a[0]+a[4]+a[8],key=a=>a.flat().map(x=>Math.round(x)).join(',');
function geometry(data){
 if(!data?.lattice||!data.atoms?.length)throw Error('Gamma geometry is missing.');
 if(data.atoms.some(a=>!Number.isFinite(a.mass)||a.mass<=0))throw Error('Positive masses are required.');
 return {cell:data.lattice,pbc:[true,true,true],atoms:data.atoms.map(a=>({element:a.element,position:S.cartesian(a.fractional,data.lattice)}))};
}
function validateBands(data,bands){
 if(!Array.isArray(bands)||bands.length!==3*data.atoms.length)throw Error('Complete 3N Gamma modes are required.');
 if(bands.length**2*data.atoms.length*3>50000000)throw Error('Mode orthogonality work budget exceeded. Geometry was not reduced.');
 for(const b of bands){let norm=0;if(!Number.isFinite(b.frequencyTHz)||!Array.isArray(b.eigenvector)||b.eigenvector.length!==data.atoms.length)throw Error('Invalid Gamma mode.');for(const a of b.eigenvector){if(a.length!==3||a.some(p=>p.length!==2||!p.every(Number.isFinite)))throw Error('Invalid complex eigenvector.');for(const p of a)norm+=p[0]**2+p[1]**2;}if(Math.abs(norm-1)>1e-6)throw Error('Gamma modes must have normalized mass-weighted eigenvectors.');}
 for(let i=0;i<bands.length;i++)for(let j=0;j<i;j++){let re=0,im=0;for(let a=0;a<data.atoms.length;a++)for(let k=0;k<3;k++){const [x,y]=bands[i].eigenvector[a][k],[u,v]=bands[j].eigenvector[a][k];re+=x*u+y*v;im+=x*v-y*u;}if(Math.hypot(re,im)>1e-5)throw Error('Gamma eigenvectors are not an orthonormal basis.');}
}
function analyze(data,bands,moyo,tolerance=1e-4){
 const structure=geometry(data);validateBands(data,bands);
 const d=moyo.analyze_cell(JSON.stringify({lattice:{basis:data.lattice.flat()},positions:data.atoms.map(a=>a.fractional),numbers:data.atoms.map(a=>S.atomicNumber(a.element))}),tolerance,'Standard');
 const group=moyo.space_group_type(d.number).geometric_crystal_class;
 const operationKeys=new Set(d.operations.map(o=>key(o.rotation)));if(operationKeys.size!==d.operations.length)throw Error('Irreps require a primitive cell. Convert the structure explicitly, then recalculate phonons.');
 if(d.operations.length*data.atoms.length*bands.length>50000000)throw Error('Irrep work budget exceeded. Geometry was not reduced.');
 const maps=PS.mapOperations(structure,d.operations,{tolerance,rotationTransposed:true});
 if(maps.maximumCorrectionAngstrom>1e-8)throw Error('The detected metric needs idealization before irrep classification. Input was not changed.');
 maps.forwardAtomPermutations.forEach(p=>p.forEach((j,i)=>{if(Math.abs(data.atoms[i].mass-data.atoms[j].mass)>1e-8)throw Error('Isotope masses break the detected structure symmetry.');}));
 const linear=rows(d.std_linear),linearInverse=inv(linear);
 const conventional=d.operations.map(o=>mm(mm(linearInverse,rows(o.rotation)),linear));
 if(conventional.some(r=>r.flat().some(x=>Math.abs(x-Math.round(x))>1e-7)))throw Error('Non-integral conventional symmetry transform.');
 let table,classes;
 for(const candidate of T.tables[group]||[]){const lookup=new Map();for(const [name,rs] of Object.entries(candidate.mapping))for(const r of rs)lookup.set(key(r),name);const found=conventional.map(r=>lookup.get(key(r)));if(found.every(Boolean)){table=candidate;classes=found;break;}}
 if(!table)throw Error('Character-table setting is unavailable for '+group+'. No irrep labels were guessed.');
 const order=classes.length,classIndex=classes.map(c=>table.classes.indexOf(c));
 const vector=maps.rotationsCartesian.map(trace),tensor=maps.rotationsCartesian.map(r=>(trace(r)**2+trace(mm([r.slice(0,3),r.slice(3,6),r.slice(6,9)],[r.slice(0,3),r.slice(3,6),r.slice(6,9)]).flat()))/2);
 const full=maps.forwardAtomPermutations.map((p,k)=>p.reduce((n,j,i)=>n+(i===j),0)*vector[k]);
 const inner=(a,b)=>a.reduce((v,x,i)=>v+x*b[i],0)/order;
 const irreps=Object.entries(table.characters).map(([label,chars])=>{const c=classIndex.map(i=>chars[i]),norm=inner(c,c);return {label,dimension:chars[0],characters:chars,operationCharacters:c,characterNorm:norm,acoustic:inner(vector,c)/norm,raman:inner(tensor,c)/norm,full:inner(full,c)/norm};});
 for(const r of irreps)for(const name of ['acoustic','raman','full']){if(Math.abs(r[name]-Math.round(r[name]))>1e-6||r[name]<-1e-6)throw Error('Noninteger Gamma representation decomposition.');r[name]=Math.round(r[name]);}
 const dim=name=>irreps.reduce((s,r)=>s+r[name]*r.dimension,0);
 if(dim('full')!==bands.length||dim('acoustic')!==3||dim('raman')!==6)throw Error('Gamma/vector/tensor dimension sum failed.');
 const modeResults=bands.map((b,modeIndex)=>{
  const overlaps=maps.forwardAtomPermutations.map((p,op)=>{const r=maps.rotationsCartesian[op];let re=0,im=0;for(let i=0;i<p.length;i++)for(let a=0;a<3;a++){let x=0,y=0;for(let k=0;k<3;k++){x+=r[3*a+k]*b.eigenvector[i][k][0];y+=r[3*a+k]*b.eigenvector[i][k][1];}const [u,v]=b.eigenvector[p[i]][a];re+=u*x+v*y;im+=u*y-v*x;}return [re,im];});
  const weights=irreps.map(r=>{const factor=r.dimension/(order*r.characterNorm);return {label:r.label,weight:factor*overlaps.reduce((s,z,i)=>s+z[0]*r.operationCharacters[i],0),imaginary:factor*overlaps.reduce((s,z,i)=>s+z[1]*r.operationCharacters[i],0)};});
  if(Math.abs(weights.reduce((s,w)=>s+w.weight,0)-1)>1e-5||weights.some(w=>Math.abs(w.imaginary)>1e-6||w.weight< -1e-6))throw Error('Irrep projector sum/residual failed.');
  const best=weights.reduce((a,b)=>a.weight>b.weight?a:b),r=irreps.find(r=>r.label===best.label),resolved=best.weight>=.999;
  let translationWeight=0;const massSum=data.atoms.reduce((s,a)=>s+a.mass,0);for(let k=0;k<3;k++){let re=0,im=0;data.atoms.forEach((a,i)=>{const f=Math.sqrt(a.mass/massSum);re+=f*b.eigenvector[i][k][0];im+=f*b.eigenvector[i][k][1];});translationWeight+=re*re+im*im;}
  return {modeIndex,label:resolved?r.label:'Unresolved / mixed',dimension:resolved?r.dimension:null,weights,projectionWeight:best.weight,translationWeight,acoustic:translationWeight>=.999,irAllowed:resolved?r.acoustic>0:null,ramanAllowed:resolved?r.raman>0:null};
 });
 return {schema:'macer-gamma-irreps-v1',spaceGroup:d.number,pointGroup:group,tolerance,order,classes:table.classes,classSizes:table.classes.map(c=>classes.filter(x=>x===c).length),irreps,fullDimension:dim('full'),acousticDimension:3,opticalDimension:bands.length-3,modes:modeResults,maxAtomMappingResidual:maps.maxCartesianResidual,source:T.sourceSHA256,mapping:maps};
}
function charges(data,input){
 const tensors=input.kind==='nominal'?data.atoms.map((a,i)=>{const q=Array.isArray(input.values)?input.values[i]:input.values?.[a.element];if(!Number.isFinite(q))throw Error('Provide an explicit finite charge for atom '+(i+1)+' '+a.element+'.');return [q,0,0,0,q,0,0,0,q];}):input.values;
 if(!Array.isArray(tensors)||tensors.length!==data.atoms.length||tensors.some(t=>!Array.isArray(t)||t.length!==9||!t.every(Number.isFinite)))throw Error('Born tensors must contain nine finite values per atom, in result atom order.');
 const sum=Array.from({length:9},(_,k)=>tensors.reduce((s,t)=>s+t[k],0)),residual=Math.max(...sum.map(Math.abs)),scale=Math.max(1,tensors.flat().reduce((s,x)=>s+Math.abs(x),0));
 if(residual>1e-6*scale)throw Error('Charge neutrality failed (residual '+residual+'). No silent charge correction was applied.');
 return {tensors:tensors.map(t=>t.slice()),neutralityResidual:residual,source:input.kind==='nominal'?'Explicit nominal-charge estimate':'Born effective-charge tensors',units:'e',inputKind:input.kind};
}
function infrared(data,bands,input){
 geometry(data);validateBands(data,bands);const c=charges(data,input);
 const modes=bands.map((b,modeIndex)=>{const real=[0,0,0],imag=[0,0,0];for(let i=0;i<data.atoms.length;i++)for(let a=0;a<3;a++)for(let k=0;k<3;k++){const z=c.tensors[i][3*a+k]/Math.sqrt(data.atoms[i].mass);real[a]+=z*b.eigenvector[i][k][0];imag[a]+=z*b.eigenvector[i][k][1];}return {modeIndex,frequencyTHz:b.frequencyTHz,frequencyCm:b.frequencyTHz*1e12/(299792458*100),effectiveChargeReal:real,effectiveChargeImag:imag,activity:real.reduce((s,x,k)=>s+x*x+imag[k]*imag[k],0),units:'e²/amu'};});
 return {schema:'macer-ir-response-v1',...c,modes,normalization:'complex coherent mode charge sum from e/sqrt(M); no frequency/Bose prefactor'};
}
root.SpectroscopyCore=Object.freeze({analyze,infrared,charges,geometry});
})(globalThis);
