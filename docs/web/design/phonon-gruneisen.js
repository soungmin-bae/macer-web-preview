/* Matrix derivative in the equilibrium eigenbasis, including degenerate subspaces. */
(function(root){
'use strict';
function projectDerivative(eigenpairs,derivative,n,indices){
  const size=indices.length,out=new Float64Array(2*size*size);
  for(let a=0;a<size;a++)for(let b=0;b<size;b++){
    let real=0,imag=0;
    for(let i=0;i<n;i++)for(let j=0;j<n;j++){
      const u=n+2*(i*n+indices[a]),v=n+2*(j*n+indices[b]),d=2*(i*n+j);
      const pr=derivative[d]*eigenpairs[v]-derivative[d+1]*eigenpairs[v+1];
      const pi=derivative[d]*eigenpairs[v+1]+derivative[d+1]*eigenpairs[v];
      real+=eigenpairs[u]*pr+eigenpairs[u+1]*pi;
      imag+=eigenpairs[u]*pi-eigenpairs[u+1]*pr;
    }
    const k=2*(a*size+b);out[k]=real;out[k+1]=imag;
  }
  return out;
}
function modes(matrix,minus,plus,n,volume,deltaVolume,kernel,compact=false){
  const eig=kernel.phonon_eigenpairs(matrix,n);
  const derivative=Float64Array.from(plus,(x,i)=>(x-minus[i])/deltaVolume);
  const groups=[];
  for(let i=0;i<n;i++){
    const last=groups.at(-1);
    if(last&&Math.abs(eig[i]-eig[last[0]])<1e-7)last.push(i);else groups.push([i]);
  }
  return groups.flatMap(indices=>{
    const projected=projectDerivative(eig,derivative,n,indices);
    const slopes=kernel.phonon_eigenpairs(projected,indices.length);
    const eigenvalue=indices.reduce((s,i)=>s+eig[i],0)/indices.length;
    const frequencyTHz=Math.sign(eigenvalue)*Math.sqrt(Math.abs(eigenvalue))*15.633302300230191;
    return indices.map((mode,i)=>({mode:mode+1,frequencyTHz,degeneracy:indices.length,
      ...(compact?{}:{eigenvector:Array.from({length:n/3},(_,atom)=>Array.from({length:3},(_,axis)=>{
        const row=atom*3+axis;
        let real=0,imag=0;
        for(let j=0;j<indices.length;j++){
          const e=n+2*(row*n+indices[j]),u=indices.length+2*(j*indices.length+i);
          real+=eig[e]*slopes[u]-eig[e+1]*slopes[u+1];
          imag+=eig[e]*slopes[u+1]+eig[e+1]*slopes[u];
        }
        return [real,imag];
      }))}),
      gruneisen:Math.abs(frequencyTHz)<1e-4||eigenvalue<0?null:-volume*slopes[i]/(2*eigenvalue),
      mask:Math.abs(frequencyTHz)<1e-4?'zero-frequency':eigenvalue<0?'imaginary':null}));
  });
}
function scaledPlan(reference,task){
  const factor=Math.cbrt(task.settings.volumeRatio),geometry=task.result.geometry;
  const deltas=geometry.positions_a.map((p,i)=>p.map((x,j)=>x-reference.primitive.atoms[i].position[j]*factor));
  return {...reference,nac:null,
    primitive:{...reference.primitive,cell:geometry.cell_a,atoms:reference.primitive.atoms.map((a,i)=>({...a,position:geometry.positions_a[i]}))},
    supercell:{...reference.supercell,cell:reference.supercell.cell.map(r=>r.map(x=>x*factor)),
      atoms:reference.supercell.atoms.map((a,i)=>({...a,position:a.position.map((x,j)=>x*factor+deltas[reference.primitiveIndices[i]][j])}))}};
}
function run(reference,project,kernel,qpoints,stepPercent=2,compact=false){
  const ratios=[1-stepPercent/100,1,1+stepPercent/100];
  const tasks=ratios.map(r=>project.tasks.find(t=>Math.abs(t.settings.volumeRatio-r)<1e-10));
  if(tasks.some(t=>t?.status!=='completed'))throw Error('Complete volumes '+ratios.map(r=>r.toFixed(4)).join(', ')+'.');
  const inputs=tasks.map(task=>{
    const plan=scaledPlan(reference,task),fc=task.result.qha.forceConstants;
    const sv=root.PhononEngine.shortestVectors(plan),maps=root.PhononEngine.dynamicalMappings(plan,fc);
    return {plan,fc,sv,maps};
  });
  const n=reference.masses.length*3;
  const volumes=tasks.map(t=>t.result.qha.volumeAngstrom3);
  const samples=qpoints.map(q=>{
    const matrices=inputs.map(({plan,fc,sv,maps})=>kernel.phonon_dynamical_matrix_at_q(
      Float64Array.from(fc.values),Float64Array.from(q),Float64Array.from(sv.vectors),Uint32Array.from(sv.multiplicity),
      Float64Array.from(plan.masses),Uint32Array.from(maps.supercellToForceConstantRow),
      Uint32Array.from(maps.primitiveToForceConstantRow),n/3,plan.supercell.atoms.length));
    return {q,modes:modes(matrices[1],matrices[0],matrices[2],n,volumes[1],volumes[2]-volumes[0],kernel,compact)};
  });
  return {schema:'macer-mode-gruneisen-v1',method:'equilibrium dynamical-matrix derivative; projected degenerate subspace eigenvalues',
    degeneracyEigenvalueTolerance:1e-7,zeroFrequencyTHz:1e-4,volumeRatios:ratios,volumesA3:volumes,
    sourceHashes:tasks.map(t=>t.result.qhaSha256),samples};
}
function runDirectional(reference,project,centerForceConstants,kernel,qpoints,groupId,stepPercent,centerHash,compact=false){
 const basis=reference.directionalBasis,group=basis?.supported&&basis.groups.find(g=>g.id===groupId);
 if(!group||!(stepPercent>0&&stepPercent<=5))throw Error('Unsupported directional analysis.');
 const tasks=[-1,1].map(sign=>project.tasks.find(t=>t.settings.analysis?.group===groupId&&t.settings.analysis.sign===sign&&t.settings.analysis.stepPercent===stepPercent));
 if(tasks.some(t=>t?.status!=='completed'))throw Error('Complete both directional strain states first.');
 const inputs=[{plan:root.PhononDirectional.deformPlan(reference,tasks[0].settings.deformation,tasks[0].result.geometry),fc:tasks[0].result.qha.forceConstants},
  {plan:reference,fc:centerForceConstants},{plan:root.PhononDirectional.deformPlan(reference,tasks[1].settings.deformation,tasks[1].result.geometry),fc:tasks[1].result.qha.forceConstants}];
 for(const input of inputs){input.sv=root.PhononEngine.shortestVectors(input.plan);input.maps=root.PhononEngine.dynamicalMappings(input.plan,input.fc);}
 const h=stepPercent/100,denominator=group.multiplicity*(Math.log1p(h)-Math.log1p(-h)),n=reference.masses.length*3;
 const samples=qpoints.map(q=>{
  const matrices=inputs.map(({plan,fc,sv,maps})=>kernel.phonon_dynamical_matrix_at_q(Float64Array.from(fc.values),Float64Array.from(q),Float64Array.from(sv.vectors),Uint32Array.from(sv.multiplicity),Float64Array.from(plan.masses),Uint32Array.from(maps.supercellToForceConstantRow),Uint32Array.from(maps.primitiveToForceConstantRow),n/3,plan.supercell.atoms.length));
  return {q,modes:modes(matrices[1],matrices[0],matrices[2],n,1,denominator,kernel,compact)};
 });
 return {schema:'macer-mode-gruneisen-v1',method:'directional dynamical-matrix derivative; projected degenerate subspace; per-axis logarithmic strain',analysis:{id:groupId,label:group.label,stepPercent,multiplicity:group.multiplicity,denominator,definition:'−(1/m) ∂lnω/∂ln s; other lattice DOF fixed; internally relaxed',basis},degeneracyEigenvalueTolerance:1e-7,zeroFrequencyTHz:1e-4,volumeRatios:[(1-h)**group.multiplicity,1,(1+h)**group.multiplicity],sourceHashes:[tasks[0].result.qhaSha256,centerHash,tasks[1].result.qhaSha256],samples};
}
root.PhononGruneisen={run,runDirectional,modes,projectDerivative};
if(typeof module==='object'&&module.exports)module.exports=root.PhononGruneisen;
})(globalThis);
