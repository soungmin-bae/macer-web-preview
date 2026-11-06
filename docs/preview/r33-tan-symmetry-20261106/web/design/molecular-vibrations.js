(function(root){
 'use strict';
 const AMU_KG=1.66053906660e-27,EV_J=1.602176634e-19,ANGSTROM_M=1e-10,SPEED_OF_LIGHT_CM_S=2.99792458e10;
 const WAVENUMBER_PER_SQRT_EV_A2_AMU=Math.sqrt(EV_J/(ANGSTROM_M*ANGSTROM_M*AMU_KG))/(2*Math.PI*SPEED_OF_LIGHT_CM_S);
 const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
 const norm=a=>Math.sqrt(dot(a,a));
 function validate(masses,positions){
  if(!Array.isArray(masses)||!Array.isArray(positions)||!positions.length||masses.length!==positions.length)throw Error('Molecular modes require one positive mass and one position per atom.');
  if(masses.some(m=>!Number.isFinite(m)||m<=0)||positions.some(p=>!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite)))throw Error('Molecular masses and Cartesian positions must be finite; masses must be positive.');
 }
 function validateMolecularStructure(structure){
  if(!structure||!Array.isArray(structure.pbc)||structure.pbc.some(Boolean))throw Error('Molecular modes require a nonperiodic XYZ structure (PBC off).');
  if(!Array.isArray(structure.positions_a)||!Array.isArray(structure.atomic_numbers))throw Error('Molecular structure is missing atomic numbers or Cartesian positions.');
  validate(structure.atomic_masses_amu,structure.positions_a);
  if(structure.atomic_numbers.length!==structure.positions_a.length)throw Error('Molecular atomic numbers and positions do not match.');
  return structure;
 }
 function orthonormalize(vectors,tol=1e-10){
  const out=[];
  for(const source of vectors){const v=source.slice();for(const q of out){const projection=dot(v,q);for(let i=0;i<v.length;i++)v[i]-=projection*q[i];}const n=norm(v);if(n>tol){for(let i=0;i<v.length;i++)v[i]/=n;out.push(v);}}
  return out;
 }
 function rigidMotionBasis(positions,masses){
  validate(masses,positions);const n=positions.length,center=[0,1,2].map(c=>positions.reduce((s,p,i)=>s+masses[i]*p[c],0)/masses.reduce((s,m)=>s+m,0));
  const candidates=[];
  for(let axis=0;axis<3;axis++){const v=Array(3*n).fill(0);for(let i=0;i<n;i++)v[3*i+axis]=Math.sqrt(masses[i]);candidates.push(v);}
  for(let axis=0;axis<3;axis++){const v=Array(3*n).fill(0);for(let i=0;i<n;i++){const r=positions[i].map((x,c)=>x-center[c]),rotation=axis===0?[0,-r[2],r[1]]:axis===1?[r[2],0,-r[0]]:[-r[1],r[0],0];for(let c=0;c<3;c++)v[3*i+c]=Math.sqrt(masses[i])*rotation[c];}candidates.push(v);}
  return orthonormalize(candidates);
 }
 function complementBasis(rigid,vectors){
  const result=[];for(let j=0;j<vectors;j++){const v=Array(vectors).fill(0);v[j]=1;for(const q of rigid){const p=dot(v,q);for(let k=0;k<vectors;k++)v[k]-=p*q[k];}for(const q of result){const p=dot(v,q);for(let k=0;k<vectors;k++)v[k]-=p*q[k];}const n=norm(v);if(n>1e-9){for(let k=0;k<vectors;k++)v[k]/=n;result.push(v);}}
  return result;
 }
 function diagonalizeSymmetric(input,tolerance=1e-13){
  const n=input.length;if(!n)return {values:[],vectors:[]};if(input.some(row=>row.length!==n||row.some(x=>!Number.isFinite(x))))throw Error('Molecular Hessian must be finite and square.');
  const a=input.map(row=>row.slice()),v=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?1:0));
  // Cyclic Jacobi sweeps are O(sweeps·n³); repeatedly searching for one
  // largest pivot makes a finite-difference molecular Hessian O(n⁴).
  const maxSweeps=Math.max(12,Math.min(80,Math.ceil(Math.log2(n+1)*8)));let converged=n<2;
  for(let sweep=0;sweep<maxSweeps;sweep++){
   let largest=0,diagonal=0;
   for(let p=0;p<n;p++)for(let q=p+1;q<n;q++)largest=Math.max(largest,Math.abs(a[p][q]));
   for(let p=0;p<n;p++)diagonal=Math.max(diagonal,Math.abs(a[p][p]));
   if(largest<=tolerance*Math.max(1,diagonal)){converged=true;break;}
   const threshold=sweep<4?largest/(4*n*n):0;
   for(let p=0;p<n;p++)for(let q=p+1;q<n;q++){
    const apq=a[p][q];if(Math.abs(apq)<=Math.max(threshold,tolerance*Math.max(1,diagonal)))continue;
    const tau=(a[q][q]-a[p][p])/(2*apq),t=(tau>=0?1:-1)/(Math.abs(tau)+Math.sqrt(1+tau*tau)),c=1/Math.sqrt(1+t*t),s=t*c;
    const app=a[p][p],aqq=a[q][q];a[p][p]=app-t*apq;a[q][q]=aqq+t*apq;a[p][q]=a[q][p]=0;
    for(let k=0;k<n;k++)if(k!==p&&k!==q){const akp=a[k][p],akq=a[k][q];a[k][p]=a[p][k]=c*akp-s*akq;a[k][q]=a[q][k]=s*akp+c*akq;}
    for(let k=0;k<n;k++){const vkp=v[k][p],vkq=v[k][q];v[k][p]=c*vkp-s*vkq;v[k][q]=s*vkp+c*vkq;}
   }
  }
  if(!converged){let residual=0,scale=1;for(let i=0;i<n;i++){scale=Math.max(scale,Math.abs(a[i][i]));for(let j=i+1;j<n;j++)residual=Math.max(residual,Math.abs(a[i][j]));}if(residual>tolerance*scale*10)throw Error(`Molecular Hessian diagonalization did not converge (off-diagonal residual ${residual.toExponential(2)}).`);}
  const order=Array.from({length:n},(_,i)=>i).sort((i,j)=>a[i][i]-a[j][j]);
  return {values:order.map(i=>a[i][i]),vectors:order.map(i=>v.map(row=>row[i]))};
 }
 function hessianFromForces(forcePlus,forceMinus,atomCount,deltaA){
  const d=3*atomCount;if(!Number.isFinite(deltaA)||deltaA<=0||forcePlus.length!==d||forceMinus.length!==d)throw Error('Invalid central force-difference inputs.');
  return Array.from({length:d},(_,row)=>Array.from({length:d},(_,col)=>-(forcePlus[col][row]-forceMinus[col][row])/(2*deltaA)));
 }
 function vibrationalModes(forceConstants,positions,masses,{rigidTolerance=1e-10,negativeEigenvalueTolerance=1e-10}={}){
  validate(masses,positions);const n=positions.length,d=3*n;if(forceConstants.length!==d||forceConstants.some(row=>row.length!==d||row.some(x=>!Number.isFinite(x))))throw Error('Cartesian force-constant matrix dimensions do not match the molecule.');
  for(let i=0;i<d;i++)for(let j=i+1;j<d;j++)if(Math.abs(forceConstants[i][j]-forceConstants[j][i])>1e-9*Math.max(1,Math.abs(forceConstants[i][j]),Math.abs(forceConstants[j][i])))throw Error('Cartesian force-constant matrix is not symmetric.');
  const sqrtMass=Array.from({length:d},(_,k)=>Math.sqrt(masses[Math.floor(k/3)]));
  const weighted=forceConstants.map((row,i)=>row.map((x,j)=>x/(sqrtMass[i]*sqrtMass[j])));
  const rigid=rigidMotionBasis(positions,masses),vibrational=complementBasis(rigid,d);
  const projected=vibrational.map(qi=>vibrational.map(qj=>dot(qi,weighted.map(row=>dot(row,qj)))));
  const eig=diagonalizeSymmetric(projected),modes=eig.values.map((lambda,index)=>{
   const massWeighted=vibrational.reduce((out,q,k)=>{for(let i=0;i<d;i++)out[i]+=q[i]*eig.vectors[index][k];return out;},Array(d).fill(0));
   const cartesian=massWeighted.map((x,i)=>x/sqrtMass[i]),massNorm=Math.sqrt(cartesian.reduce((sum,x,i)=>sum+masses[Math.floor(i/3)]*x*x,0));
   for(let i=0;i<cartesian.length;i++)cartesian[i]/=massNorm;
   const stableLambda=Math.abs(lambda)<=negativeEigenvalueTolerance?0:lambda;
   return {eigenvalue_ev_a2_amu:stableLambda,frequency_cm1:Math.sign(stableLambda)*Math.sqrt(Math.abs(stableLambda))*WAVENUMBER_PER_SQRT_EV_A2_AMU,imaginary:stableLambda<0,eigenvector_cartesian:cartesian};
  });
  return {schema:'macer-molecular-modes-v1',atom_count:n,rigid_mode_count:rigid.length,vibrational_mode_count:modes.length,positions_a:positions.map(p=>p.slice()),masses_amu:masses.slice(),modes};
 }
 async function finiteDifferenceModes(structure,evaluateForces,{deltaA=0.005,signal,onProgress}={}){
  validateMolecularStructure(structure);if(typeof evaluateForces!=='function')throw Error('A molecular force evaluator is required.');
  if(!Number.isFinite(deltaA)||deltaA<1e-4||deltaA>0.05)throw Error('Molecular force-difference step must be between 0.0001 and 0.05 Å.');
  const base=structure.positions_a.map(p=>p.slice()),d=base.length*3,h=Array.from({length:d},()=>Array(d).fill(0));
  for(let col=0;col<d;col++){
   if(signal?.aborted)throw new DOMException('Molecular modes calculation stopped.','AbortError');
   const atom=Math.floor(col/3),axis=col%3,plus=base.map(p=>p.slice()),minus=base.map(p=>p.slice());plus[atom][axis]+=deltaA;minus[atom][axis]-=deltaA;
   const fp=await evaluateForces(plus,structure);if(signal?.aborted)throw new DOMException('Molecular modes calculation stopped.','AbortError');const fm=await evaluateForces(minus,structure);
   if(signal?.aborted)throw new DOMException('Molecular modes calculation stopped.','AbortError');
   if(fp.length!==base.length||fm.length!==base.length||[...fp,...fm].some(f=>!Array.isArray(f)||f.length!==3||!f.every(Number.isFinite)))throw Error('Force evaluator returned an invalid molecular force array.');
   for(let row=0;row<d;row++)h[row][col]=-(fp[Math.floor(row/3)][row%3]-fm[Math.floor(row/3)][row%3])/(2*deltaA);
   onProgress?.({completed_displacements:col+1,total_displacements:d,completed_force_evaluations:(col+1)*2,total_force_evaluations:2*d});
  }
  for(let i=0;i<d;i++)for(let j=i+1;j<d;j++){const mean=(h[i][j]+h[j][i])/2;h[i][j]=h[j][i]=mean;}
  return { ...vibrationalModes(h,base,structure.atomic_masses_amu),force_constants_ev_a2:h,delta_a:deltaA,force_evaluation_count:2*d };
 }
 root.MolecularVibrations=Object.freeze({WAVENUMBER_PER_SQRT_EV_A2_AMU,validateMolecularStructure,rigidMotionBasis,diagonalizeSymmetric,hessianFromForces,vibrationalModes,finiteDifferenceModes});
})(globalThis);
