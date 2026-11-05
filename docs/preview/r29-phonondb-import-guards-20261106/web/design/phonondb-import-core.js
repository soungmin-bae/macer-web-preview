/* User-selected, local Phonopy parameter import for PhononDB references. */
(function(root){
  'use strict';
  const finite=Number.isFinite, S=()=>root.Structures;
  function fail(message){throw new Error('PhononDB import: '+message);}
  function vec(value,label){if(!Array.isArray(value)||value.length!==3||value.some(x=>!finite(x)))fail(label+' must contain three finite numbers.');return value.slice();}
  function cell(value,label){if(!Array.isArray(value)||value.length!==3)return fail(label+' must contain three lattice vectors.');const rows=value.map((r,i)=>vec(r,label+' row '+(i+1)));if(Math.abs(S().determinant(rows))<1e-10)fail(label+' is singular.');return rows;}
  function sourceRecord(url){
    let u;try{u=new URL(String(url));}catch{fail('Enter the NIMS MDR record URL.');}
    if(u.protocol!=='https:'||u.hostname!=='mdr.nims.go.jp'||!/^\/datasets\/[0-9a-f-]{36}\/?$/i.test(u.pathname))fail('The source must be an HTTPS NIMS MDR dataset record URL.');
    return u.href.replace(/\/$/,'');
  }
  function sourceAttribution(value){
    if(!value||typeof value!=='object')fail('Add the NIMS record URL, its individual-record license, and confirm that you checked the record metadata.');
    const sourceURL=sourceRecord(value.recordUrl),recordLicense=String(value.recordLicense||'').trim();
    if(!recordLicense)fail('Enter the license shown on this individual NIMS record. The collection license is not used as a substitute.');
    if(value.licenseAcknowledged!==true)fail('Confirm that you checked the individual record license before importing.');
    return {sourceURL,recordLicense,licenseStatus:'user-attested',licenseAcknowledged:true};
  }
  function latticePoints(block,label,maxAtoms=512){
    if(!block||typeof block!=='object')fail('Missing '+label+'.');
    const lattice=cell(block.lattice,label+' lattice'),points=block.points;
    if(!Array.isArray(points)||points.length<1||points.length>maxAtoms)fail(label+' must contain 1–'+maxAtoms+' atoms.');
    const atoms=points.map((p,i)=>{
      const element=p?.symbol,number=S().atomicNumber(element),fractional=vec(p?.coordinates,label+' atom '+(i+1)+' coordinate'),mass=p?.mass??root.MacerAtomicMasses?.[number];
      if(!number)fail(label+' atom '+(i+1)+' has an unknown element.');
      if(!finite(mass)||mass<=0)fail(label+' atom '+(i+1)+' has no valid mass.');
      return {element,mass,position:S().cartesian(fractional,lattice),fractional};
    });
    return {cell:lattice,pbc:[true,true,true],atoms};
  }
  function atomMap(supercell,primitive,tolerance){
    const mapping=supercell.atoms.map((atom,index)=>{
      const f=S().fractional(atom.position,primitive.cell);let best=null;
      primitive.atoms.forEach((p,i)=>{if(p.element!==atom.element||Math.abs(p.mass-atom.mass)>1e-3)return;const d=f.map((x,k)=>x-S().fractional(p.position,primitive.cell)[k]),wrapped=d.map(x=>x-Math.round(x)),distance=Math.hypot(...S().cartesian(wrapped,primitive.cell));if(!best||distance<best.distance)best={i,distance};});
      if(!best||best.distance>tolerance)fail('Supercell atom '+(index+1)+' does not map to a primitive atom ('+(best?.distance??Infinity).toExponential(2)+' Å).');
      return best.i;
    });
    const counts=new Array(primitive.atoms.length).fill(0);mapping.forEach(i=>counts[i]++);
    if(counts.some(n=>n<1))fail('A primitive atom has no supercell image.');
    return mapping;
  }
  function primitiveRepresentatives(raw,supercell,primitive,indices,tolerance){
    const points=raw.supercell.points,targets=[];
    if(points.every(p=>Number.isInteger(p.reduced_to))){
      for(let i=0;i<points.length;i++)if(points[i].reduced_to===i+1)targets.push(i);
      if(!targets.length)fail('Phonopy reduced_to representative map is empty.');
      for(const p of points)if(!Number.isInteger(p.reduced_to)||p.reduced_to<1||p.reduced_to>points.length||points[p.reduced_to-1].reduced_to!==p.reduced_to)fail('Phonopy reduced_to map is inconsistent.');
      if(targets.length!==primitive.atoms.length)fail('Phonopy representative count does not match primitive atoms.');
    }else{
      indices.forEach((primitiveIndex,supercellIndex)=>{if(!targets.some(i=>indices[i]===primitiveIndex))targets.push(supercellIndex);});
    }
    const result=new Array(primitive.atoms.length).fill(-1);
    for(const supercellIndex of targets){
      const primitiveIndex=indices[supercellIndex],f=S().fractional(supercell.atoms[supercellIndex].position,primitive.cell),p=S().fractional(primitive.atoms[primitiveIndex].position,primitive.cell),d=f.map((x,k)=>x-p[k]),distance=Math.hypot(...S().cartesian(d.map(x=>x-Math.round(x)),primitive.cell));
      if(distance>tolerance)fail('Phonopy representative does not coincide with primitive atom '+(primitiveIndex+1)+'.');
      if(result[primitiveIndex]>=0)fail('More than one representative maps to primitive atom '+(primitiveIndex+1)+'.');
      result[primitiveIndex]=supercellIndex;
    }
    if(result.some(i=>i<0))fail('A primitive atom has no Phonopy supercell representative.');
    return result;
  }
  function units(raw){
    const p=raw.physical_unit||{};
    const mass=String(p.atomic_mass||'AMU').toLowerCase(),length=String(p.length||'angstrom').toLowerCase().replaceAll('å','angstrom'),fc=String(p.force_constants||'eV/angstrom^2').toLowerCase().replaceAll('å','angstrom');
    if(!['amu','atomic_mass_unit'].includes(mass)||!['angstrom','ang'].includes(length)||!['ev/angstrom^2','ev/ang^2'].includes(fc))fail('Only AMU, Å, and eV/Å² Phonopy parameters are supported.');
  }
  function validateDisplacements(raw,natoms){
    const list=raw.displacements;
    if(!Array.isArray(list)||!list.length||list.length>3*natoms)fail('This record needs a Phonopy displacement-force dataset (1–3N displacements).');
    return list.map((d,i)=>{
      const atom=Number(d?.atom)-1,displacement=vec(d?.displacement,'displacement '+(i+1)),forces=d?.forces;
      if(!Number.isInteger(atom)||atom<0||atom>=natoms)fail('Displacement '+(i+1)+' has an invalid one-based supercell atom index.');
      if(!Array.isArray(forces)||forces.length!==natoms||forces.some(v=>!Array.isArray(v)||v.length!==3||v.some(x=>!finite(x))))fail('Displacement '+(i+1)+' must include one finite force vector for every supercell atom.');
      if(Math.hypot(...displacement)===0)fail('A displacement vector is zero.');
      return {id:i,atom,vector:displacement,forces:forces.map(v=>v.slice())};
    });
  }
  async function calculate(text,attribution,moyo,kernel,onProgress=()=>{}){
    const source=sourceAttribution(attribution);
    if(typeof text!=='string'||!text.trim())fail('The selected YAML file is empty.');
    if(new TextEncoder().encode(text).byteLength>25*1024*1024)fail('The uncompressed YAML exceeds the 25 MiB import limit.');
    if(!root.jsyaml?.load)fail('The local YAML parser did not load.');
    let raw;
    try{raw=root.jsyaml.load(text,{schema:root.jsyaml.JSON_SCHEMA,maxAliasCount:0});}catch(e){fail('Could not parse phonopy_params.yaml: '+(e.message||'invalid YAML'));}
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||!raw.phonopy)fail('The file is not a Phonopy parameter document.');
    units(raw);
    const supercell=latticePoints(raw.supercell,'supercell'),primitive=latticePoints(raw.primitive_cell,'primitive cell',256);
    if(supercell.atoms.length>512)fail('This preview supports at most 512 supercell atoms.');
    const symprec=Number(raw.phonopy.symmetry_tolerance??1e-5);if(!finite(symprec)||symprec<1e-7||symprec>1e-2)fail('Phonopy symmetry tolerance is outside the supported range.');
    const displacements=validateDisplacements(raw,supercell.atoms.length),primitiveIndices=atomMap(supercell,primitive,Math.max(symprec*2,1e-4)),primitiveRepresentativeIndices=primitiveRepresentatives(raw,supercell,primitive,primitiveIndices,Math.max(symprec*2,1e-4));
    if(!moyo?.analyze_cell||!kernel?.phonon_eigenpairs)fail('The local symmetry or phonon WASM kernel is unavailable.');
    const numbers=supercell.atoms.map(a=>S().atomicNumber(a.element)),positions=supercell.atoms.map(a=>S().fractional(a.position,supercell.cell));
    const ds=moyo.analyze_cell(JSON.stringify({lattice:{basis:supercell.cell.flat()},positions,numbers}),symprec,'Standard');
    if(!Array.isArray(ds.operations)||!ds.operations.length||ds.operations.length>16384||ds.operations.length*supercell.atoms.length>4000000)fail('The imported supercell symmetry is larger than the safe preview limit.');
    const mapping=root.PhononSymmetry.mapOperations(supercell,ds.operations,{tolerance:Math.max(symprec*2,1e-4),rotationTransposed:true});
    if(mapping.maxCartesianResidual>Math.max(symprec*2,1e-4))fail('The source supercell could not be matched to its symmetry operations.');
    const reps=[...new Set(displacements.map(d=>d.atom))],siteMaps=reps.map(atom=>({atom,indices:mapping.forwardAtomPermutations.flatMap((p,i)=>p[atom]===atom?[i]:[])}));
    if(reps.some((atom,i)=>siteMaps[i].indices.length===0))fail('A displaced atom has no valid site-symmetry operations.');
    const plan={schema:'macer-phonopy-reference-plan-v1',supercell,primitive,primitiveIndices,primitiveRepresentativeIndices,representatives:reps,displacements:displacements.map(({id,atom,vector})=>({id,atom,vector})),siteMaps,mapping,masses:primitive.atoms.map(a=>a.mass),settings:{nacEnabled:false,nacMethod:'gonze',nacDirection:null,symprec,jobKind:'bands',samples:21,pathMode:'auto'},input:supercell,spaceGroup:Number(raw.space_group?.number)||ds.number,execution:null};
    const forceRecords=Object.fromEntries(displacements.map(d=>[d.id,{forces:d.forces}]));
    onProgress('Reconstructing force constants',0,1);
    const fc=root.PhononEngine.forceConstants(plan,forceRecords,kernel);
    const primitiveNumbers=primitive.atoms.map(a=>S().atomicNumber(a.element)),primitivePositions=primitive.atoms.map(a=>S().fractional(a.position,primitive.cell));
    const primitiveSymmetry=moyo.analyze_cell(JSON.stringify({lattice:{basis:primitive.cell.flat()},positions:primitivePositions,numbers:primitiveNumbers}),symprec,'Standard');
    plan.path=root.PhononPath.automatic(primitive,moyo,kernel,symprec,21);
    onProgress('Calculating reference bands',0,plan.path.segments.length*21);
    const result=await root.PhononEngine.bands(plan,fc,kernel,(done,total,stage)=>onProgress(stage,done,total));
    result.reference={provider:'PhononDB / NIMS Materials Data Repository',...source,sourceFormat:'phonopy_params.yaml',sourcePhonopyVersion:String(raw.phonopy.version||'unknown'),sourceSpaceGroup:Number(raw.space_group?.number)||primitiveSymmetry.number,symprec,forceConstants:'reconstructed in browser from source displacement-force data; no model force evaluations',nacAvailable:Array.isArray(raw.born_effective_charge)&&Array.isArray(raw.dielectric_constant),nacApplied:false};
    result.validation={state:'imported-reference',software:'Phonopy parameter local import',physicalAccuracy:'source reference data; no prediction claim'};
    return {result,forceConstants:fc,source:{url:source.sourceURL,recordLicense:source.recordLicense,licenseStatus:source.licenseStatus,licenseAcknowledged:source.licenseAcknowledged,phonopyVersion:result.reference.sourcePhonopyVersion,spaceGroup:result.reference.sourceSpaceGroup,primitiveAtoms:primitive.atoms.length,supercellAtoms:supercell.atoms.length,displacements:displacements.length,operationCount:mapping.operationCount,nacAvailable:result.reference.nacAvailable,nacApplied:false}};
  }
  root.PhononDbImportCore=Object.freeze({calculate,sourceRecord,sourceAttribution,latticePoints,atomMap,primitiveRepresentatives,validateDisplacements,units});
  if(typeof module==='object'&&module.exports)module.exports=root.PhononDbImportCore;
})(globalThis);
