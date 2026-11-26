/* Weighted harmonic thermodynamics on the same regular q grid as DOS. */
(function(root){
'use strict';
const FREQUENCY_FACTOR=15.633302300230191;
const SPECTRUM_BUDGET=32*1024*1024;
const GAMMA_RESIDUAL_THZ=1e-4;
const VERSION='harmonic-thermal-v1';

function validateSettings({mesh,temperatures}){
  if(!Array.isArray(mesh)||mesh.length!==3||mesh.some(n=>!Number.isInteger(n)||n<2||n>100)){
    throw Error('Thermal q-mesh needs three integers from 2 to 100.');
  }
  if(!Array.isArray(temperatures)||!temperatures.length||temperatures.length>501||
     temperatures.some(t=>!Number.isFinite(t)||t<0)){
    throw Error('Supply 1–501 finite, nonnegative temperatures.');
  }
}

// The eigensolver returns mass-normalized vectors. Project each Γ mode onto
// the three sqrt(mass)-weighted uniform translations.
function gammaTranslations(eigenpairs, frequencies, masses){
  const n=frequencies.length;
  const massSum=masses.reduce((sum,mass)=>sum+mass,0);
  const weights=masses.map(mass=>Math.sqrt(mass/massSum));
  const overlaps=Array.from({length:n},(_,mode)=>{
    let norm=0;
    for(let axis=0;axis<3;axis++){
      let re=0,im=0;
      weights.forEach((weight,atom)=>{
        const k=n+((3*atom+axis)*n+mode)*2;
        re+=weight*eigenpairs[k];im+=weight*eigenpairs[k+1];
      });
      norm+=re*re+im*im;
    }
    return {mode,norm};
  });
  const translations=overlaps.sort((a,b)=>b.norm-a.norm).slice(0,3);
  const overlap=translations.reduce((sum,entry)=>sum+entry.norm,0);
  const modes=translations.map(entry=>entry.mode).sort((a,b)=>a-b);
  const residuals=modes.map(mode=>frequencies[mode]);
  if(overlap<3-1e-6||residuals.some(f=>Math.abs(f)>GAMMA_RESIDUAL_THZ)){
    throw Error('The three Γ translations are not numerically zero. Check the acoustic sum rule before integrating.');
  }
  return {modes,overlap,residualsTHz:residuals};
}

async function run(plan,fc,kernel,options,onProgress=()=>{}){
  validateSettings(options);
  const {mesh,temperatures,includeSpectrum=false}=options;
  const np=plan.primitive.atoms.length,ns=plan.supercell.atoms.length,n=3*np;
  const nq=mesh.reduce((product,value)=>product*value,1);
  if(nq*n*8>SPECTRUM_BUDGET){
    throw Error('The thermal frequency array exceeds 32 MiB. Use a smaller q-mesh.');
  }
  const fcs=Float64Array.from(fc.values);
  const sv=root.PhononEngine.shortestVectors(plan);
  const maps=root.PhononEngine.dynamicalMappings(plan,fc);
  const vectors=Float64Array.from(sv.vectors),multiplicity=Uint32Array.from(sv.multiplicity);
  const masses=Float64Array.from(plan.masses);
  const supercellRows=Uint32Array.from(maps.supercellToForceConstantRow);
  const primitiveRows=Uint32Array.from(maps.primitiveToForceConstantRow);
  const nac=await root.PhononNac.prepare(plan,fc,kernel,sv,(done,total)=>onProgress('NAC preparation',done,total));
  const frequencies=new Float64Array(nq*n),weights=new Uint32Array(nq).fill(1);
  const qCoordinates=new Float64Array(3);
  let gamma=null;
  let imaginaryCount=0,unstableQPoints=0,minimumMode=null;
  const shifts=mesh.map(value=>value%2===0?0.5:0);
  for(let i=0;i<nq;i++){
    const rawQ=root.PhononDos.qpoint(i,mesh),isGamma=rawQ.every(value=>value===0);
    qCoordinates.set(rawQ);
    const matrix=nac&&!isGamma?nac.matrix(root.PhononNac.nearestBZ(rawQ,plan.primitive.cell),null):
      kernel.phonon_dynamical_matrix_at_q(fcs,qCoordinates,vectors,multiplicity,masses,supercellRows,primitiveRows,np,ns);
    const eig=kernel.phonon_eigenpairs(matrix,n);
    const row=frequencies.subarray(i*n,(i+1)*n);
    for(let mode=0;mode<n;mode++){
      row[mode]=Math.sign(eig[mode])*Math.sqrt(Math.abs(eig[mode]))*FREQUENCY_FACTOR;
      if(!Number.isFinite(row[mode]))throw Error(`Non-finite frequency at q (${rawQ.join(', ')}), mode ${mode+1}.`);
    }
    if(isGamma){
      gamma={qIndex:i,...gammaTranslations(eig,row,plan.masses)};
      for(const mode of gamma.modes)row[mode]=0;
    }
    let unstable=false;
    for(let mode=0;mode<n;mode++){
      const frequency=row[mode];
      if(frequency<0){
        unstable=true;imaginaryCount++;
        if(!minimumMode||frequency<minimumMode.frequencyTHz){
          minimumMode={q:rawQ,mode,frequencyTHz:frequency};
        }
      }
    }
    if(unstable)unstableQPoints++;
    if((i+1)%64===0||i+1===nq){
      onProgress('Sampling q-mesh',i+1,nq);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
  }
  const forceConstantsHash=await root.PhononDos.hash({format:fc.format??'full',values:fc.values});
  const provenance={
    model:plan.execution?.modelKey??null,
    forceConstantsHash, massAmu:Array.from(masses),
    primitiveCell:plan.primitive.cell,
    primitiveAtoms:plan.primitive.atoms,
    supercellMatrix:plan.supercellMatrix,
    primitiveRepresentatives:root.PhononEngine.primitiveRepresentatives(plan),
    dynamicalMappings:maps,
    nac: nac?{method:nac.method,exactGamma:'analytic',parameters:plan.nac}:null,
  };
  const meshHash=await root.PhononDos.hash({version:VERSION,mesh,shifts,provenance});
  const spectrum=includeSpectrum?{spectrum:{frequencies,weights}}:{};
  const metadata={schema:VERSION,mesh,shifts,meshHash,provenance,gamma,
    primitiveAtomCount:np,supercellAtomCount:ns,qWeightSum:nq,
    weightedModeCount:n*nq,integratedWeightedModeCount:n*nq-(gamma?3:0),...spectrum};
  if(imaginaryCount){
    return {...metadata,stability:{status:'unstable',imaginaryCount,unstableQPoints,minimumMode}};
  }
  const gammaDescriptor=gamma?[gamma.qIndex,...gamma.modes]:[];
  const values=kernel.phonon_harmonic_thermal(frequencies,weights,np,Float64Array.from(temperatures),Uint32Array.from(gammaDescriptor));
  const rows=temperatures.map((temperature_k,i)=>{
    const k=7+4*i;
    return {temperature_k,free_energy_ev_per_atom:values[k+1],entropy_kb_per_atom:values[k+2],heat_capacity_kb_per_atom:values[k+3]};
  });
  return {
    ...metadata,stability:{status:'stable'},
    primitiveAtomCount:values[1],qWeightSum:values[2],
    weightedModeCount:values[3],integratedWeightedModeCount:values[4],
    thzToEv:values[5],boltzmannEvPerK:values[6],
    zpe_ev_per_atom:values[0],rows,
  };
}
root.PhononThermal={run,validateSettings};
})(globalThis);
