/* DFT-tensor-fitted periodic bond-polarizability response; float64, file-I/O-free. */
(function(root){'use strict';
 const bundle=root.RamanFEREBundle,styles=root.ElementStyles,S=root.Structures;
 const SQRT2=Math.sqrt(2),CM_PER_THz=33.35640951981521;
 const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
 const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
 const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
 const norm=a=>Math.hypot(a[0],a[1],a[2]);
 const finite3=a=>Array.isArray(a)&&a.length===3&&a.every(Number.isFinite);
 function switchValue(x){
  if(x<=1.15)return [1,0];if(x>=1.35)return [0,0];
  const t=(x-1.15)/0.2;
  return [1-10*t**3+15*t**4-6*t**5,(-30*t*t+60*t**3-30*t**4)/0.2];
 }
 function candidate(){
  if(!bundle||bundle.schema!=='macer-fere-raman-browser-bundle-v1'||bundle.qualification!=='PASS_APPROXIMATE_RAMAN_PREVIEW_V1')throw Error('Qualified FERE Raman bundle is unavailable.');
  const m=bundle.candidate?.model;
  if(!m||m.global?.length!==6||!Array.isArray(m.elements)||!Array.isArray(m.pairs||[]))throw Error('Unsupported frozen FERE Raman candidate schema.');
  const elements=new Map(m.elements.map(row=>[row.atomicNumber,row.coefficients]));
  const pairs=new Map();
  for(const row of m.pairs||[]){
   if(!Array.isArray(row.elements)||row.elements.length!==2||!Array.isArray(row.coefficients)||row.coefficients.length!==6||row.coefficients.some(x=>!Number.isFinite(x)))throw Error('Invalid FERE Raman pair correction.');
   const key=row.elements.slice().sort().join('-');if(pairs.has(key))throw Error(`Duplicate FERE Raman pair correction: ${key}.`);pairs.set(key,row.coefficients);
  }
  return {m,elements,pairs};
 }
 function prepare(data){
  if(!styles||!S)throw Error('FERE Raman structure tables are unavailable.');
  if(!Array.isArray(data?.lattice)||data.lattice.length!==3||!data.lattice.every(finite3))throw Error('FERE Raman requires a finite periodic 3D cell.');
  const volume=Math.abs(S.determinant(data.lattice));if(!Number.isFinite(volume)||volume<1e-10)throw Error('FERE Raman cell is singular.');
  if(!Array.isArray(data.atoms)||!data.atoms.length)throw Error('FERE Raman needs atoms.');
  const atoms=data.atoms.map((a,i)=>{
   const el=styles[a.element],mass=a.mass;
   if(!el||!Number.isFinite(el.atomic_number)||!Number.isFinite(el.covalent_radius_angstrom)||el.covalent_radius_angstrom<=0)throw Error(`FERE Raman has no covalent radius for ${a.element||`atom ${i+1}`}.`);
   if(!finite3(a.fractional)||!Number.isFinite(mass)||mass<=0)throw Error('FERE Raman requires finite fractional coordinates and positive masses.');
   return {element:a.element,z:el.atomic_number,mass,fractional:a.fractional.slice(),radius:el.covalent_radius_angstrom};
  });
  const lattice=data.lattice.map(r=>r.slice()),positions=atoms.map(a=>S.cartesian(a.fractional,lattice));
  const [a,b,c]=lattice,det=S.determinant(lattice);if(!Number.isFinite(det)||Math.abs(det)<1e-10)throw Error('FERE Raman cell is singular.');
  const recip=[cross(b,c),cross(c,a),cross(a,b)].map(v=>v.map(x=>x/det));
  const candidateModel=candidate(),bonds=[];let candidatesVisited=0,totalEndpoints=0,coveredEndpoints=0;
  for(let i=0;i<atoms.length;i++)for(let j=i;j<atoms.length;j++){
   const scale=atoms[i].radius+atoms[j].radius,cutoff=1.35*scale,df=sub(atoms[j].fractional,atoms[i].fractional);
   const bounds=recip.map((v,k)=>{const h=cutoff*norm(v);return [Math.ceil(-df[k]-h-1e-10),Math.floor(-df[k]+h+1e-10)];});
   const count=bounds.reduce((n,[lo,hi])=>n*Math.max(0,hi-lo+1),1);candidatesVisited+=count;
   if(candidatesVisited>2_000_000)throw Error('FERE Raman periodic-image budget exceeded. No cell or atom reduction was applied.');
   for(let x=bounds[0][0];x<=bounds[0][1];x++)for(let y=bounds[1][0];y<=bounds[1][1];y++)for(let z=bounds[2][0];z<=bounds[2][1];z++){
    const t=[x,y,z];if(i===j&&(t[0]||t[1]||t[2])&&!(t[0]>0||t[0]===0&&(t[1]>0||t[1]===0&&t[2]>0)))continue;if(i===j&&!t.some(Boolean))continue;
    const shift=S.cartesian(t,lattice),v=[0,1,2].map(k=>positions[j][k]+shift[k]-positions[i][k]),r=norm(v);if(r<1e-8)throw Error('Coincident periodic atoms in FERE Raman input.');
    const xx=r/scale;if(xx>=1.35-1e-12)continue;
    const pairKey=[atoms[i].element,atoms[j].element].sort().join('-');
    bonds.push({i,j,t,shift,scale,zi:atoms[i].z,zj:atoms[j].z,pairKey});
    if(candidateModel.elements.has(atoms[i].z))coveredEndpoints++;
    if(candidateModel.elements.has(atoms[j].z))coveredEndpoints++;
    totalEndpoints+=2;
    if(bonds.length>100_000)throw Error('FERE Raman bond budget exceeded. Structure was not reduced.');
   }
  }
  if(!bonds.length)throw Error('No periodic bonds fall inside the fitted FERE model cutoff.');
  const fittedAtomicNumbers=[...new Set(atoms.filter(a=>candidateModel.elements.has(a.z)).map(a=>a.z))].sort((x,y)=>x-y);
  const globalOnlyAtomicNumbers=[...new Set(atoms.filter(a=>!candidateModel.elements.has(a.z)).map(a=>a.z))].sort((x,y)=>x-y);
  const pairCoveredBonds=bonds.reduce((n,bond)=>n+(candidateModel.pairs.has(bond.pairKey)?1:0),0);
  const fittedPairBondFraction=bonds.length?pairCoveredBonds/bonds.length:0;
  const encounteredPairLabels=[...new Set(bonds.map(bond=>bond.pairKey))].sort();
  const matchedPairLabels=encounteredPairLabels.filter(label=>candidateModel.pairs.has(label));
  const unmatchedBondPairLabels=encounteredPairLabels.filter(label=>!candidateModel.pairs.has(label));
  return {lattice,atoms,positions,bonds,volume,candidatesVisited,candidateModel,
   diagnostics:{periodicBondCount:bonds.length,periodicImageCandidates:candidatesVisited,
    fittedAtomicNumbers,globalOnlyAtomicNumbers,
    fittedBondEndpointFraction:totalEndpoints?coveredEndpoints/totalEndpoints:0,
    fittedPairBondFraction,matchedPairLabels,unmatchedBondPairLabels,
    bondStage:pairCoveredBonds?'global+element+pair-residual':'global+element'} };
 }
 function oneDerivative(prepared,displacement){
  const out=Array(9).fill(0),{m,elements}=prepared.candidateModel,global=m.global;
  for(const bond of prepared.bonds){
   const {i,j,shift,scale,zi,zj,pairKey}=bond;
   const v=[0,1,2].map(k=>prepared.positions[j][k]+shift[k]-prepared.positions[i][k]),r=norm(v),x=r/scale;
   if(x>=1.35)continue;
   const n=v.map(q=>q/r),dv=sub(displacement[j],displacement[i]),dr=dot(n,dv),dx=dr/scale,dn=dv.map((q,k)=>(q-n[k]*dr)/r);
   const [w,dwdx]=switchValue(x),uI=elements.get(zi),uJ=elements.get(zj),pairCorrection=prepared.candidateModel.pairs.get(pairKey),coeff=global.map((v,k)=>v+0.5*((uI?.[k]||0)+(uJ?.[k]||0))+(pairCorrection?.[k]||0));
   const q=[
    [n[0]*n[0]-1/3,n[0]*n[1],n[0]*n[2]],
    [n[1]*n[0],n[1]*n[1]-1/3,n[1]*n[2]],
    [n[2]*n[0],n[2]*n[1],n[2]*n[2]-1/3]
   ];
   const dq=Array.from({length:3},(_,a)=>Array.from({length:3},(_,b)=>dn[a]*n[b]+n[a]*dn[b]));
   let da=0,db=0,b=0;
   for(let p=0;p<3;p++){
    const ci=coeff[p],power=p+1;da+=ci*(dwdx*x**power+w*power*x**(power-1))*dx;
    const ca=coeff[3+p],xp=p===0?1:x**p,dxp=p===0?0:p*x**(p-1);
    db+=ca*(dwdx*xp+w*dxp)*dx;b+=ca*w*xp;
   }
   for(let a=0;a<3;a++)for(let c=0;c<3;c++)out[a*3+c]+=da*(a===c?1:0)+db*q[a][c]+b*dq[a][c];
  }
  return out;
 }
 function activity(real,imag){
  const sq=(a,b)=>a*a+b*b, tr=(a,b)=>(real[a]-real[b])**2+(imag[a]-imag[b])**2;
  const meanR=(real[0]+real[4]+real[8])/3,meanI=(imag[0]+imag[4]+imag[8])/3;
  const gamma=.5*(tr(0,4)+tr(4,8)+tr(8,0)+6*(sq(real[1],imag[1])+sq(real[2],imag[2])+sq(real[5],imag[5])));
  return 45*sq(meanR,meanI)+7*gamma;
 }
 function mode(prepared,band,index){
  if(!Number.isFinite(band.frequencyTHz)||!Array.isArray(band.eigenvector)||band.eigenvector.length!==prepared.atoms.length)throw Error('A complete Γ eigenvector is required for the FERE Raman tensor.');
  let norm2=0;const re=[],im=[];
  for(let i=0;i<prepared.atoms.length;i++){
   const e=band.eigenvector[i];if(!Array.isArray(e)||e.length!==3||e.some(v=>!Array.isArray(v)||v.length!==2||!v.every(Number.isFinite)))throw Error('Invalid complex Γ eigenvector.');
   const rootMass=Math.sqrt(prepared.atoms[i].mass);re.push(e.map(v=>v[0]/rootMass));im.push(e.map(v=>v[1]/rootMass));for(const v of e)norm2+=v[0]**2+v[1]**2;
  }
  if(Math.abs(norm2-1)>1e-6)throw Error(`Γ eigenvectors must be normalized (sum |e|² = 1; received ${norm2}).`);
  const tensorReal=oneDerivative(prepared,re),tensorImag=oneDerivative(prepared,im),value=activity(tensorReal,tensorImag);
  if(!tensorReal.every(Number.isFinite)||!tensorImag.every(Number.isFinite)||!Number.isFinite(value))throw Error('FERE Raman produced a nonfinite tensor or activity.');
  const frequencyCm=band.frequencyTHz*CM_PER_THz;
  return {modeIndex:index,frequencyTHz:band.frequencyTHz,frequencyCm,tensorReal,tensorImag,activity:value,activityPerVolume:value/prepared.volume,
   status:band.frequencyTHz<0?'Imaginary':band.frequencyTHz<0.1?'Near zero':'Optical-frequency',responseKind:'fere-dft-fitted-bond-polarizability',candidateId:bundle.candidateId};
 }
 function batch(prepared,bands,startIndex=0){
  if(!Array.isArray(bands)||bands.length!==3*prepared.atoms.length||!Number.isInteger(startIndex)||startIndex<0||startIndex>bands.length)throw Error('Invalid Γ mode count or resume index.');
  return bands.slice(startIndex).map((band,k)=>mode(prepared,band,startIndex+k));
 }
 const api=Object.freeze({prepare,mode,batch,switchValue,activity,identity:bundle&&{id:bundle.id,kernel:bundle.kernel,candidateId:bundle.candidateId,candidateSHA256:bundle.candidateSHA256}});
 root.RamanFERECore=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
