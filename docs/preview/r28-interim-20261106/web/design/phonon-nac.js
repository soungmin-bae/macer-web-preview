/* BORN parsing and phonopy 4.4.0 Gonze/Wang preparation. All in the Worker.
 * Reciprocal dipole sums use the local Rust/WASM phonors kernel. */
(function(root){
 'use strict';
 const S=root.Structures,dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0),norm=a=>Math.hypot(...a);
 const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
 const qcart=(q,cell)=>[0,1,2].map(i=>dot(S.fractional([+(i===0),+(i===1),+(i===2)],cell),q));
 const mm=(a,b)=>Array.from({length:9},(_,i)=>[0,1,2].reduce((v,k)=>v+a[Math.floor(i/3)*3+k]*b[k*3+i%3],0));
 const tr=a=>[a[0],a[3],a[6],a[1],a[4],a[7],a[2],a[5],a[8]];
 function parse(text,primitive,mapping,method='gonze'){
  if(!['gonze','wang'].includes(method))throw Error('NAC method must be Gonze or Wang.');
  const lines=text.trim().split(/\r?\n/).filter(s=>s.trim());
  if(lines.length<3)throw Error('BORN needs a factor/comment line, a dielectric tensor and independent-atom charge tensors.');
  const header=lines.shift().split(/\s+/),numeric=s=>Number(String(s).replace(/[dD]/g,'e'));
  const factor=Number.isFinite(numeric(header[0]))?numeric(header[0]):14.39965172592227;
  const gCutoff=numeric(header[1]),lambda=numeric(header[2]);
  if(!(factor>0))throw Error('BORN conversion factor must be positive.');
  if(Number.isFinite(gCutoff)&&gCutoff<=0||Number.isFinite(lambda)&&lambda<=0)throw Error('BORN G cutoff and Lambda must be positive.');
  function tensor(line){const a=line.split(/\s+/).map(numeric);if(a.length!==9||!a.every(Number.isFinite))throw Error('Every BORN tensor row must contain exactly nine finite values.');return a;}
  let dielectric=tensor(lines.shift());
  if(dielectric.some((x,i)=>Math.abs(x-tr(dielectric)[i])>1e-8))throw Error('The dielectric tensor must be symmetric.');
  // Positive definite via Cholesky; no silent clipping of an invalid tensor.
  const l=Array(9).fill(0);for(let i=0;i<3;i++)for(let j=0;j<=i;j++){let v=dielectric[3*i+j];for(let k=0;k<j;k++)v-=l[3*i+k]*l[3*j+k];if(i===j){if(v<=0)throw Error('The dielectric tensor must be positive definite.');l[3*i+j]=Math.sqrt(v);}else l[3*i+j]=v/l[3*j+j];}
  const count=primitive.atoms.length,seen=new Set(),representatives=[];
  for(let i=0;i<count;i++)if(!seen.has(i)){representatives.push(i);mapping.forwardAtomPermutations.forEach(p=>seen.add(p[i]));}
  if(lines.length!==representatives.length)throw Error(`BORN requires ${representatives.length} independent-atom tensors in standardized primitive order (${representatives.map(i=>`${i+1} ${primitive.atoms[i].element}`).join(', ')}); received ${lines.length}. Preview the primitive before preparing BORN.`);
  let born=Array(count);
  representatives.forEach((rep,k)=>{
   const tensorValue=tensor(lines[k]);
   for(let i=0;i<count;i++)if(!born[i]){
    const op=mapping.forwardAtomPermutations.findIndex(p=>p[rep]===i);if(op<0)continue;
    const r=mapping.rotationsCartesian[op];born[i]=mm(mm(r,tensorValue),tr(r));
   }
  });
  if(born.some(b=>!b))throw Error('BORN symmetry expansion failed.');
  const neutralityResidual=Math.max(...Array.from({length:9},(_,a)=>Math.abs(born.reduce((s,b)=>s+b[a],0))));
  const rawBorn=born.map(b=>b.slice()),rawDielectric=dielectric.slice(),operations=mapping.forwardAtomPermutations.length;
  const average=Array.from({length:count},()=>Array(9).fill(0)),epsilon=Array(9).fill(0);
  mapping.forwardAtomPermutations.forEach((perm,op)=>{
   const r=mapping.rotationsCartesian[op],rt=tr(r),e=mm(mm(r,dielectric),rt);
   for(let a=0;a<9;a++)epsilon[a]+=e[a]/operations;
   perm.forEach((target,source)=>{const b=mm(mm(r,born[source]),rt);for(let a=0;a<9;a++)average[target][a]+=b[a]/operations;});
  });
  const drift=Array.from({length:9},(_,a)=>average.reduce((sum,b)=>sum+b[a]/count,0));
  born=average.map(b=>b.map((x,a)=>x-drift[a]));dielectric=epsilon;
  const tensorSymmetryResidual=Math.max(...born.flatMap((b,i)=>b.map((x,a)=>Math.abs(x-rawBorn[i][a]))),...dielectric.map((x,a)=>Math.abs(x-rawDielectric[a])));
  return {method,factor,dielectric,born,rawBorn,rawDielectric,tensorSymmetryResidual,representatives,neutralityResidual,...(Number.isFinite(gCutoff)?{gCutoff}:{}),...(Number.isFinite(lambda)?{lambda}:{})};
 }
 function nearestBZ(q,cell){
  const cart=qcart(q,cell),trial=q.map(Math.round),upper=norm(qcart(q.map((x,i)=>x-trial[i]),cell))+1e-10;
  // Bounds follow |(q-G)·a_i| <= |q-G| |a_i|; valid for skew cells.
  const lo=q.map((x,i)=>Math.ceil(x-upper*norm(cell[i]))),hi=q.map((x,i)=>Math.floor(x+upper*norm(cell[i])));
  let best=Infinity,out=q;const count=hi.reduce((n,x,i)=>n*(x-lo[i]+1),1);if(count>200000)throw Error('Cell is too skew for NAC Brillouin-zone mapping.');
  for(let a=lo[0];a<=hi[0];a++)for(let b=lo[1];b<=hi[1];b++)for(let c=lo[2];c<=hi[2];c++){const p=q.map((x,i)=>x-[a,b,c][i]),v=norm(qcart(p,cell));if(v<best-1e-12){best=v;out=p;}}
  return out;
 }
 const hermitian=m=>{const n=Math.sqrt(m.length/2);for(let i=0;i<n;i++)for(let j=i;j<n;j++){const a=2*(i*n+j),b=2*(j*n+i),re=(m[a]+m[b])/2,im=(m[a+1]-m[b+1])/2;m[a]=m[b]=re;m[a+1]=im;m[b+1]=-im;}return m;};
 async function prepare(plan,fc,kernel,sv,progress=()=>{}){
  const p=plan.nac;if(!p)return null;
  const np=plan.primitive.atoms.length,ns=plan.supercell.atoms.length,n=np*3,cell=plan.primitive.cell,volume=Math.abs(dot(cell[0],cross(cell[1],cell[2]))),factor=p.factor*4*Math.PI/volume;
  const dm=(values,q)=>kernel.phonon_dynamical_matrix_at_q(new Float64Array(values),new Float64Array(q),new Float64Array(sv.vectors),new Uint32Array(sv.multiplicity),new Float64Array(plan.masses),new Uint32Array(plan.primitiveIndices),new Uint32Array(Array.from({length:np},(_,i)=>i)),np,ns);
  const state={...p,factor,volume};
  if(p.method==='wang'){
   state.matrix=(q,direction)=>{
    const qc=qcart(direction||q,cell);if(norm(qc)<1e-5)return dm(fc.values,q);
    const den=dot(qc,[0,1,2].map(i=>dot(p.dielectric.slice(3*i,3*i+3),qc)));
    const charge=p.born.map(b=>[0,1,2].map(a=>[0,1,2].reduce((s,k)=>s+qc[k]*b[3*k+a],0)));
    const values=fc.values.slice(0,np*ns*9),N=ns/np;
    for(let i=0;i<np;i++)for(let k=0;k<ns;k++)for(let a=0;a<3;a++)for(let b=0;b<3;b++)values[(i*ns+k)*9+a*3+b]+=factor/den/N*charge[i][a]*charge[plan.primitiveIndices[k]][b];
    return dm(values,q);
   };return state;
  }
  const cutoff=p.gCutoff??Math.cbrt(3*300/(4*Math.PI)/volume),lambda=p.lambda??Math.sqrt(-(cutoff**2)*(p.dielectric[0]+p.dielectric[4]+p.dielectric[8])/3/4/Math.log(1e-10));
  const limits=cell.map(a=>Math.ceil(cutoff*norm(a))),g=[];
  if(limits.reduce((n,a)=>n*(a*2+1),1)>2000000)throw Error('NAC reciprocal sum exceeds this browser preview resource limit.');
  for(let a=-limits[0];a<=limits[0];a++)for(let b=-limits[1];b<=limits[1];b++)for(let c=-limits[2];c<=limits[2];c++){const v=qcart([a,b,c],cell);if(norm(v)<cutoff)g.push(...v);}
  const gf=new Float64Array(g),bf=new Float64Array(p.born.flat()),eps=new Float64Array(p.dielectric),pos=new Float64Array(plan.primitive.atoms.flatMap(a=>a.position));
  const zero=new Float64Array([0,0,0]),empty=new Float64Array();
  const q0=kernel.phonon_gonze_reciprocal(gf,zero,empty,bf,eps,pos,factor,lambda,empty);
  function longRange(q,direction){
   const dd=kernel.phonon_gonze_reciprocal(gf,new Float64Array(qcart(q,cell)),direction?new Float64Array(qcart(direction,cell)):empty,bf,eps,pos,factor,lambda,q0);
   for(let i=0;i<n;i++)for(let j=0;j<n;j++){const w=1/Math.sqrt(plan.masses[Math.floor(i/3)]*plan.masses[Math.floor(j/3)]),index=(i*n+j)*2;dd[index]*=w;dd[index+1]*=w;}
   return hermitian(dd);
  }
  // Inverse transform the dipole contribution at every commensurate point.
  // This removes the same periodic long-range content already in the input FC.
  const compact=Float64Array.from(fc.values.slice(0,np*ns*9)),N=ns/np;
  let done=0,maxImaginaryResidual=0;
  for(let a=0;a<plan.repeat[0];a++)for(let b=0;b<plan.repeat[1];b++)for(let c=0;c<plan.repeat[2];c++){
   const q=nearestBZ([a/plan.repeat[0],b/plan.repeat[1],c/plan.repeat[2]],cell),dd=longRange(q,null);
   for(let i=0;i<np;i++)for(let k=0;k<ns;k++){
    const j=plan.primitiveIndices[k],[multi,first]=sv.multiplicity.slice((k*np+i)*2,(k*np+i)*2+2);
    let re=0,im=0;for(let v=first;v<first+multi;v++){const phase=2*Math.PI*dot(q,sv.vectors.slice(v*3,v*3+3));re+=Math.cos(phase)/multi;im-=Math.sin(phase)/multi;}
    const scale=Math.sqrt(plan.masses[i]*plan.masses[j])/N;
    for(let x=0;x<3;x++)for(let y=0;y<3;y++){const index=((i*3+x)*n+j*3+y)*2;compact[(i*ns+k)*9+x*3+y]-=(dd[index]*re-dd[index+1]*im)*scale;maxImaginaryResidual=Math.max(maxImaginaryResidual,Math.abs((dd[index]*im+dd[index+1]*re)*scale));}
   }
   progress(++done,N);if(done%4===0)await new Promise(r=>setTimeout(r,0));
  }
  state.shortRangeForceConstants=Array.from(compact);state.gCutoff=cutoff;state.lambda=lambda;state.gPoints=g.length/3;state.inverseTransformMaxImaginaryTerm=maxImaginaryResidual;
  state.matrix=(q,direction)=>{
   // Phonopy's public run() omits NAC at Gamma when no approach is specified.
   if(norm(qcart(direction||q,cell))<1e-5)return dm(fc.values,q);
   const short=dm(compact,q),long=longRange(q,direction);for(let i=0;i<short.length;i++)short[i]+=long[i];return hermitian(short);
  };
  return state;
 }
 root.PhononNac={parse,prepare,nearestBZ,qcart};
 if(typeof module==='object'&&module.exports)module.exports=root.PhononNac;
})(globalThis);
