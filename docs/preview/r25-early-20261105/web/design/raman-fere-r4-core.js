/* Opt-in experimental R4 Raman tensor: frozen R3 bond model + fitted smooth local-environment residual. */
(function(root){'use strict';
 const bundle=root.RamanFEREPreviewBundle,styles=root.ElementStyles,S=root.Structures;
 const CM_PER_THz=33.35640951981521,EPS=1e-12;
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
  if(!bundle||bundle.schema!=='macer-fere-raman-preview-bundle-v1'||bundle.qualification!=='EXPLORATORY_PREVIEW_ONLY')throw Error('Experimental FERE R4 local preview bundle is unavailable.');
  const m=bundle.candidate?.model,e=bundle.environmentResidual?.model;
  if(bundle.environmentResidual?.candidateId!==bundle.candidateId||e?.schema!=='macer-fere-environment-linear-residual-v1'||
     e.baselineCandidateId!==bundle.candidate?.candidateId||m?.global?.length!==6||!Array.isArray(m.elements)||!Array.isArray(m.pairs)||!Array.isArray(e.features))
    throw Error('Unsupported experimental FERE R4 bundle schema or baseline identity.');
  const elements=new Map(m.elements.map(row=>[row.atomicNumber,row.coefficients]));
  const pairs=new Map();
  for(const row of m.pairs){if(!Array.isArray(row.elements)||row.elements.length!==2||!Array.isArray(row.coefficients)||row.coefficients.length!==6||row.coefficients.some(x=>!Number.isFinite(x)))throw Error('Invalid R4 baseline pair coefficients.');pairs.set(row.elements.slice().sort().join('-'),row.coefficients);}
  const environment=new Map();
  for(const row of e.features){if(!Number.isInteger(row.atomicNumber)||!['coordination','asymmetry'].includes(row.feature)||!Array.isArray(row.coefficients)||row.coefficients.length!==6||row.coefficients.some(x=>!Number.isFinite(x)))throw Error('Invalid R4 environment residual.');const item=environment.get(row.atomicNumber)||{};if(item[row.feature])throw Error('Duplicate R4 environment feature row.');item[row.feature]=row.coefficients;environment.set(row.atomicNumber,item);}
  const mean=e.normalization?.mean,std=e.normalization?.populationStd;
  if(!mean||!std||!Number.isFinite(mean.coordination)||!Number.isFinite(mean.asymmetry)||!Number.isFinite(std.coordination)||!Number.isFinite(std.asymmetry)||std.coordination<=0||std.asymmetry<=0)throw Error('Invalid R4 train-only feature normalization.');
  return {m,e,elements,pairs,environment,mean,std};
 }
 function geometry(prepared,bond,positions=prepared.positions){
  const {i,j,shift,scale}=bond,v=[0,1,2].map(k=>positions[j][k]+shift[k]-positions[i][k]);
  const r=norm(v);if(!(r>1e-10))throw Error('Coincident periodic atoms in R4 Raman input.');
  const x=r/scale,n=v.map(q=>q/r),[w,dwdx]=switchValue(x);
  return {v,r,x,n,w,dwdx};
 }
 function environmentBase(prepared,positions=prepared.positions){
  const count=prepared.atoms.length,C=Array(count).fill(0),M=Array.from({length:count},()=>[0,0,0]);
  for(const bond of prepared.bonds){const g=geometry(prepared,bond,positions),{i,j}=bond,{n,w}=g;
   C[i]+=w;C[j]+=w;for(let k=0;k<3;k++){M[i][k]+=w*n[k];M[j][k]-=w*n[k];}
  }
  const A=C.map((v,i)=>dot(M[i],M[i])/(v*v+EPS));
  const bondC=prepared.bonds.map(b=>0.5*(C[b.i]+C[b.j]));
  const bondA=prepared.bonds.map(b=>0.5*(A[b.i]+A[b.j]));
  return {coordination:C,moment:M,asymmetry:A,bondCoordination:bondC,bondAsymmetry:bondA};
 }
 function prepare(data){
  if(!styles||!S)throw Error('FERE R4 structure tables are unavailable.');
  if(!Array.isArray(data?.lattice)||data.lattice.length!==3||!data.lattice.every(finite3))throw Error('FERE R4 requires a finite periodic 3D cell.');
  const volume=Math.abs(S.determinant(data.lattice));if(!Number.isFinite(volume)||volume<1e-10)throw Error('FERE R4 cell is singular.');
  if(!Array.isArray(data.atoms)||!data.atoms.length)throw Error('FERE R4 needs atoms.');
  const atoms=data.atoms.map((a,i)=>{const el=styles[a.element];if(!el||!Number.isFinite(el.atomic_number)||!Number.isFinite(el.covalent_radius_angstrom)||el.covalent_radius_angstrom<=0)throw Error(`FERE R4 has no covalent radius for ${a.element||`atom ${i+1}`}.`);if(!finite3(a.fractional)||!Number.isFinite(a.mass)||a.mass<=0)throw Error('FERE R4 requires finite fractional coordinates and positive masses.');return {element:a.element,z:el.atomic_number,mass:a.mass,fractional:a.fractional.slice(),radius:el.covalent_radius_angstrom};});
  const lattice=data.lattice.map(row=>row.slice()),positions=atoms.map(a=>S.cartesian(a.fractional,lattice)),[a,b,c]=lattice,det=S.determinant(lattice);
  if(!Number.isFinite(det)||Math.abs(det)<1e-10)throw Error('FERE R4 cell is singular.');
  const recip=[cross(b,c),cross(c,a),cross(a,b)].map(v=>v.map(x=>x/det)),candidateModel=candidate(),bonds=[];let candidatesVisited=0,totalEndpoints=0,coveredEndpoints=0;
  for(let i=0;i<atoms.length;i++)for(let j=i;j<atoms.length;j++){
   const scale=atoms[i].radius+atoms[j].radius,cutoff=1.35*scale,df=sub(atoms[j].fractional,atoms[i].fractional);
   const bounds=recip.map((v,k)=>{const h=cutoff*norm(v);return [Math.ceil(-df[k]-h-1e-10),Math.floor(-df[k]+h+1e-10)];});
   candidatesVisited+=bounds.reduce((n,[lo,hi])=>n*Math.max(0,hi-lo+1),1);if(candidatesVisited>2_000_000)throw Error('FERE R4 periodic-image budget exceeded; no structure reduction was applied.');
   for(let x=bounds[0][0];x<=bounds[0][1];x++)for(let y=bounds[1][0];y<=bounds[1][1];y++)for(let z=bounds[2][0];z<=bounds[2][1];z++){
    const t=[x,y,z];if(i===j&&(t.some(Boolean)&&!(t[0]>0||t[0]===0&&(t[1]>0||t[1]===0&&t[2]>0))))continue;if(i===j&&!t.some(Boolean))continue;
    const shift=S.cartesian(t,lattice),v=[0,1,2].map(k=>positions[j][k]+shift[k]-positions[i][k]),r=norm(v);if(r<1e-8)throw Error('Coincident periodic atoms in FERE R4 input.');if(r/scale>=1.35-1e-12)continue;
    const pairKey=[atoms[i].element,atoms[j].element].sort().join('-');bonds.push({i,j,t,shift,scale,zi:atoms[i].z,zj:atoms[j].z,pairKey});
    if(candidateModel.elements.has(atoms[i].z))coveredEndpoints++;if(candidateModel.elements.has(atoms[j].z))coveredEndpoints++;totalEndpoints+=2;
    if(bonds.length>100_000)throw Error('FERE R4 bond budget exceeded; no structure reduction was applied.');
   }
  }
  if(!bonds.length)throw Error('No periodic bonds fall inside the FERE R4 cutoff.');
  const prepared={lattice,atoms,positions,bonds,volume,candidatesVisited,candidateModel};prepared.environment=environmentBase(prepared);
  const fittedAtomicNumbers=[...new Set(atoms.filter(a=>candidateModel.elements.has(a.z)).map(a=>a.z))].sort((x,y)=>x-y),globalOnlyAtomicNumbers=[...new Set(atoms.filter(a=>!candidateModel.elements.has(a.z)).map(a=>a.z))].sort((x,y)=>x-y);
  const pairCoveredBonds=bonds.reduce((n,bond)=>n+(candidateModel.pairs.has(bond.pairKey)?1:0),0),encounteredPairLabels=[...new Set(bonds.map(bond=>bond.pairKey))].sort();
  prepared.diagnostics={periodicBondCount:bonds.length,periodicImageCandidates:candidatesVisited,fittedAtomicNumbers,globalOnlyAtomicNumbers,fittedBondEndpointFraction:totalEndpoints?coveredEndpoints/totalEndpoints:0,fittedPairBondFraction:bonds.length?pairCoveredBonds/bonds.length:0,matchedPairLabels:encounteredPairLabels.filter(label=>candidateModel.pairs.has(label)),unmatchedBondPairLabels:encounteredPairLabels.filter(label=>!candidateModel.pairs.has(label)),bondStage:pairCoveredBonds?'global+element+pair+environment-residual':'global+element+environment-residual',qualification:'exploratory-local-preview-only'};
  return prepared;
 }
 function environmentDerivative(prepared,displacement){
  const {atoms,bonds,candidateModel}=prepared,count=atoms.length,dC=Array(count).fill(0),dM=Array.from({length:count},()=>[0,0,0]);
  for(const bond of bonds){const {i,j}=bond,g=geometry(prepared,bond),dv=sub(displacement[j],displacement[i]),radial=dot(g.n,dv),dx=radial/bond.scale,dn=dv.map((v,k)=>(v-g.n[k]*radial)/g.r),dw=g.dwdx*dx;
   dC[i]+=dw;dC[j]+=dw;for(let k=0;k<3;k++){dM[i][k]+=dw*g.n[k]+g.w*dn[k];dM[j][k]+=-dw*g.n[k]-g.w*dn[k];}
  }
  const env=prepared.environment,dA=env.coordination.map((c,i)=>2*dot(env.moment[i],dM[i])/(c*c+EPS)-2*c*dC[i]*dot(env.moment[i],env.moment[i])/((c*c+EPS)**2));
  return {bondCoordination:bonds.map(b=>0.5*(dC[b.i]+dC[b.j])),bondAsymmetry:bonds.map(b=>0.5*(dA[b.i]+dA[b.j]))};
 }
 function oneDerivative(prepared,displacement){
  const out=Array(9).fill(0),{m,elements,pairs,environment,mean,std}=prepared.candidateModel,global=m.global,envD=environmentDerivative(prepared,displacement),env=prepared.environment;
  for(let bi=0;bi<prepared.bonds.length;bi++){
   const bond=prepared.bonds[bi],{i,j,scale,zi,zj,pairKey}=bond,g=geometry(prepared,bond),{x,n,w,dwdx,r}=g;if(x>=1.35)continue;
   const dv=sub(displacement[j],displacement[i]),dr=dot(n,dv),dx=dr/scale,dn=dv.map((q,k)=>(q-n[k]*dr)/r),uI=elements.get(zi),uJ=elements.get(zj),pairCorrection=pairs.get(pairKey),base=global.map((v,k)=>v+0.5*((uI?.[k]||0)+(uJ?.[k]||0))+(pairCorrection?.[k]||0));
   const cBar=(env.bondCoordination[bi]-mean.coordination)/std.coordination,aBar=(env.bondAsymmetry[bi]-mean.asymmetry)/std.asymmetry;
   const dcBar=envD.bondCoordination[bi]/std.coordination,daBar=envD.bondAsymmetry[bi]/std.asymmetry,ei=environment.get(zi),ej=environment.get(zj),coef=[...base],dcoef=Array(6).fill(0);
   for(const [key,value,dvalue] of [['coordination',cBar,dcBar],['asymmetry',aBar,daBar]])for(let p=0;p<6;p++){const pair=0.5*((ei?.[key]?.[p]||0)+(ej?.[key]?.[p]||0));coef[p]+=pair*value;dcoef[p]+=pair*dvalue;}
   const q=[[n[0]*n[0]-1/3,n[0]*n[1],n[0]*n[2]],[n[1]*n[0],n[1]*n[1]-1/3,n[1]*n[2]],[n[2]*n[0],n[2]*n[1],n[2]*n[2]-1/3]],dq=Array.from({length:3},(_,a)=>Array.from({length:3},(_,bb)=>dn[a]*n[bb]+n[a]*dn[bb]));
   let da=0,db=0,beta=0;
   for(let p=0;p<3;p++){
    const power=p+1,basisI=w*x**power,dBasisI=(dwdx*x**power+w*power*x**(power-1))*dx;da+=coef[p]*dBasisI+dcoef[p]*basisI;
    const xp=p===0?1:x**p,dxp=p===0?0:p*x**(p-1),basisA=w*xp,dBasisA=(dwdx*xp+w*dxp)*dx;db+=coef[3+p]*dBasisA+dcoef[3+p]*basisA;beta+=coef[3+p]*basisA;
   }
   for(let aa=0;aa<3;aa++)for(let bb=0;bb<3;bb++)out[aa*3+bb]+=da*(aa===bb?1:0)+db*q[aa][bb]+beta*dq[aa][bb];
  }
  return out;
 }
 function polarizability(prepared,positions=prepared.positions){
  const out=Array(9).fill(0),{m,elements,pairs,environment,mean,std}=prepared.candidateModel,env=environmentBase(prepared,positions);
  for(let bi=0;bi<prepared.bonds.length;bi++){
   const bond=prepared.bonds[bi],{i,j,zi,zj,pairKey}=bond,g=geometry(prepared,bond,positions),{x,n,w}=g;if(x>=1.35)continue;
   const ui=elements.get(zi),uj=elements.get(zj),pc=pairs.get(pairKey),coeff=m.global.map((v,k)=>v+0.5*((ui?.[k]||0)+(uj?.[k]||0))+(pc?.[k]||0));
   const cBar=(env.bondCoordination[bi]-mean.coordination)/std.coordination,aBar=(env.bondAsymmetry[bi]-mean.asymmetry)/std.asymmetry,ei=environment.get(zi),ej=environment.get(zj);
   for(let p=0;p<6;p++)coeff[p]+=0.5*((ei?.coordination?.[p]||0)+(ej?.coordination?.[p]||0))*cBar+0.5*((ei?.asymmetry?.[p]||0)+(ej?.asymmetry?.[p]||0))*aBar;
   const iso=coeff[0]*w*x+coeff[1]*w*x*x+coeff[2]*w*x*x*x,ani=coeff[3]*w+coeff[4]*w*x+coeff[5]*w*x*x,q=[[n[0]*n[0]-1/3,n[0]*n[1],n[0]*n[2]],[n[1]*n[0],n[1]*n[1]-1/3,n[1]*n[2]],[n[2]*n[0],n[2]*n[1],n[2]*n[2]]];
   for(let aa=0;aa<3;aa++)for(let bb=0;bb<3;bb++)out[aa*3+bb]+=iso*(aa===bb?1:0)+ani*q[aa][bb];
  }
  return out;
 }
 function activity(real,imag){
  const sq=(a,b)=>a*a+b*b,tr=(a,b)=>(real[a]-real[b])**2+(imag[a]-imag[b])**2,meanR=(real[0]+real[4]+real[8])/3,meanI=(imag[0]+imag[4]+imag[8])/3;
  const gamma=0.5*(tr(0,4)+tr(4,8)+tr(8,0)+6*(sq(real[1],imag[1])+sq(real[2],imag[2])+sq(real[5],imag[5])));return 45*sq(meanR,meanI)+7*gamma;
 }
 function mode(prepared,band,index){
  if(!Number.isFinite(band.frequencyTHz)||!Array.isArray(band.eigenvector)||band.eigenvector.length!==prepared.atoms.length)throw Error('A complete Γ eigenvector is required for FERE R4 Raman tensor.');
  let norm2=0;const re=[],im=[];for(let i=0;i<prepared.atoms.length;i++){const e=band.eigenvector[i];if(!Array.isArray(e)||e.length!==3||e.some(v=>!Array.isArray(v)||v.length!==2||!v.every(Number.isFinite)))throw Error('Invalid complex Γ eigenvector.');const rm=Math.sqrt(prepared.atoms[i].mass);re.push(e.map(v=>v[0]/rm));im.push(e.map(v=>v[1]/rm));for(const v of e)norm2+=v[0]**2+v[1]**2;}
  if(Math.abs(norm2-1)>1e-6)throw Error(`Γ eigenvectors must be normalized (sum |e|² = 1; received ${norm2}).`);
  const tensorReal=oneDerivative(prepared,re),tensorImag=oneDerivative(prepared,im),value=activity(tensorReal,tensorImag);if(!tensorReal.every(Number.isFinite)||!tensorImag.every(Number.isFinite)||!Number.isFinite(value))throw Error('FERE R4 produced a nonfinite tensor or activity.');
  return {modeIndex:index,frequencyTHz:band.frequencyTHz,frequencyCm:band.frequencyTHz*CM_PER_THz,tensorReal,tensorImag,activity:value,activityPerVolume:value/prepared.volume,status:band.frequencyTHz<0?'Imaginary':band.frequencyTHz<0.1?'Near zero':'Optical-frequency',responseKind:'experimental-fere-r4-local-environment-tensor',candidateId:bundle.candidateId,qualification:'EXPLORATORY_PREVIEW_ONLY'};
 }
 function batch(prepared,bands,startIndex=0){if(!Array.isArray(bands)||bands.length!==3*prepared.atoms.length||!Number.isInteger(startIndex)||startIndex<0||startIndex>bands.length)throw Error('Invalid FERE R4 Γ mode count or resume index.');return bands.slice(startIndex).map((band,k)=>mode(prepared,band,startIndex+k));}
 const api=Object.freeze({prepare,mode,batch,polarizability,switchValue,activity,identity:bundle&&{id:bundle.id,kernel:bundle.kernel,candidateId:bundle.candidateId,candidateSHA256:bundle.candidateSHA256,qualification:bundle.qualification}});
 root.RamanFEREPreviewCore=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
