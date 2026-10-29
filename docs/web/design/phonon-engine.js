/* Browser-only finite displacements and result assembly. No model or network I/O. */
(function(root) {
  'use strict';
  const S = root.Structures;
  const dot=(a,b)=>a.reduce((v,x,i)=>v+x*b[i],0);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const norm=a=>Math.hypot(...a);
  const wrap=f=>f.map(x=>x-Math.floor(x));
  const rotate=(r,v)=>[0,1,2].map(i=>dot(r.slice(i*3,i*3+3),v));
  const engineStructure=s=>({atomic_numbers:s.atoms.map(a=>S.atomicNumber(a.element)),positions_a:s.atoms.map(a=>a.position.slice()),cell_a:s.cell.map(r=>r.slice()),pbc:[true,true,true]});
  function rank(vectors) {
    const basis=[];
    for(const v of vectors){const w=v.slice();for(const b of basis){const p=dot(w,b);for(let i=0;i<3;i++)w[i]-=p*b[i];}const n=norm(w);if(n>1e-7)basis.push(w.map(x=>x/n));}
    return basis.length;
  }
  function path(text,samples) {
    if(!Number.isInteger(samples)||samples<2||samples>501)throw Error('Samples per segment must be 2–501.');
    const points=text.trim().split(/\n+/).filter(x=>x.trim()).map(line=>{
      const [label,...xyz]=line.trim().split(/\s+/);const q=xyz.map(Number);
      if(!label||q.length!==3||!q.every(Number.isFinite))throw Error('Each path row needs a label and three reciprocal fractional coordinates.');
      return {label,q};
    });
    if(points.length<2||points.length>32)throw Error('Enter 2–32 path endpoints.');
    return {points,samples,source:'Manual',segments:points.slice(0,-1).map((p,i)=>[p,points[i+1]])};
  }
  function plan(structure,settings,moyo,kernel) {
    if(!structure?.cell||!structure.atoms?.length||!structure.pbc?.every(Boolean))throw Error('Phonons require a periodic POSCAR or CIF structure.');
    const input={lattice:{basis:structure.cell.flat()},positions:structure.atoms.map(a=>S.fractional(a.position,structure.cell)),numbers:structure.atoms.map(a=>S.atomicNumber(a.element))};
    const dataset=moyo.analyze_cell(JSON.stringify(input),settings.symprec,'Standard');
    const pc=dataset.prim_std_cell;
    const cell=[0,1,2].map(i=>pc.lattice.basis.slice(i*3,i*3+3));
    const primitive={cell,pbc:[true,true,true],atoms:pc.numbers.map((z,i)=>({element:S.elementSymbol(z),position:S.cartesian(wrap(pc.positions[i]),cell),mask:[true,true,true]}))};
    const volume=Math.abs(dot(cell[0],cross(cell[1],cell[2])));
    const heights=cell.map((_,i)=>volume/norm(cross(cell[(i+1)%3],cell[(i+2)%3])));
    const repeat=settings.supercellMode==='auto'?heights.map(h=>Math.max(1,Math.ceil(settings.minimumLength/h))):settings.repeats;
    if(!Array.isArray(repeat)||repeat.length!==3||repeat.some(n=>!Number.isInteger(n)||n<1||n>12))throw Error('Supercell repeat must contain three integers from 1 to 12.');
    const count=primitive.atoms.length*repeat.reduce((a,b)=>a*b,1);
    if(count>512)throw Error(`The requested supercell has ${count} atoms; this preview supports at most 512. Choose an explicit smaller supercell to proceed.`);
    const supercell={cell:cell.map((r,i)=>r.map(x=>x*repeat[i])),pbc:[true,true,true],atoms:[]};
    const primitiveIndices=[];
    for(let a=0;a<repeat[0];a++)for(let b=0;b<repeat[1];b++)for(let c=0;c<repeat[2];c++)primitive.atoms.forEach((atom,i)=>{
      const f=wrap(pc.positions[i]).map((v,j)=>v+[a,b,c][j]);
      supercell.atoms.push({element:atom.element,position:S.cartesian(f,cell),mask:[true,true,true]});primitiveIndices.push(i);
    });
    // Lift primitive operations and lattice translations analytically. A full
    // supercell symmetry search plus quadratic nearest-site scans is prohibitive.
    const pfrac=primitive.atoms.map(a=>S.fractional(a.position,cell));
    const pd=moyo.analyze_cell(JSON.stringify({lattice:{basis:cell.flat()},positions:pfrac,numbers:pc.numbers}),settings.symprec,'Standard');
    const pm=root.PhononSymmetry.mapOperations(primitive,pd.operations,{tolerance:settings.symprec*2,rotationTransposed:true});
    const perms=[],rotations=[];let maxResidual=0;
    pd.operations.forEach((op,opIndex)=>{
      const v=op.rotation,r=[v[0],v[3],v[6],v[1],v[4],v[7],v[2],v[5],v[8]];
      // Only rotations preserving this explicitly chosen supercell are valid.
      if(r.some((x,index)=>Math.abs(x*repeat[index%3]/repeat[Math.floor(index/3)]-Math.round(x*repeat[index%3]/repeat[Math.floor(index/3)]))>1e-8))return;
      const siteShift=pfrac.map((f,i)=>{
        const j=pm.forwardAtomPermutations[opIndex][i];
        const delta=rotate(r,f).map((x,a)=>x+op.translation[a]-pfrac[j][a]);
        const shift=delta.map(Math.round);maxResidual=Math.max(maxResidual,norm(S.cartesian(delta.map((x,a)=>x-shift[a]),cell)));
        return {j,shift};
      });
      for(let u=0;u<repeat[0];u++)for(let v=0;v<repeat[1];v++)for(let w=0;w<repeat[2];w++){
        const permutation=[];
        for(let a=0;a<repeat[0];a++)for(let b=0;b<repeat[1];b++)for(let c=0;c<repeat[2];c++){
          const rt=rotate(r,[a,b,c]);
          for(const s of siteShift){const t=rt.map((x,j)=>((Math.round(x+s.shift[j]+[u,v,w][j])%repeat[j])+repeat[j])%repeat[j]);permutation.push(((t[0]*repeat[1]+t[1])*repeat[2]+t[2])*primitive.atoms.length+s.j);}
        }
        if(new Set(permutation).size!==count)throw Error('Supercell symmetry map is not a bijection.');
        perms.push(permutation);rotations.push(pm.rotationsCartesian[opIndex]);
      }
    });
    if(maxResidual>settings.symprec*2||!perms.length)throw Error('Primitive-to-supercell operation mapping failed.');
    const mapping={forwardAtomPermutations:perms,rotationsCartesian:rotations,operationCount:perms.length,maxCartesianResidual:maxResidual};
    const seen=new Set(),representatives=[],displacements=[],siteMaps=[];
    const candidates=[[1,0,0],[0,1,0],[0,0,1],[1,1,0],[1,0,1],[0,1,1],[1,1,1]];
    for(let atom=0;atom<count;atom++){
      if(seen.has(atom))continue;
      representatives.push(atom);mapping.forwardAtomPermutations.forEach(p=>seen.add(p[atom]));
      const site=[];mapping.forwardAtomPermutations.forEach((p,i)=>{if(p[atom]===atom)site.push(i);});
      let best=null;
      for(const d of candidates){const orbit=site.map(i=>rotate(mapping.rotationsCartesian[i],d));if(rank(orbit)===3){best=[d];break;}}
      if(!best){best=[];let vectors=[];for(const d of candidates){const extra=site.map(i=>rotate(mapping.rotationsCartesian[i],d));if(rank([...vectors,...extra])>rank(vectors)){best.push(d);vectors.push(...extra);}if(rank(vectors)===3)break;}}
      if(!best||rank(best.flatMap(d=>site.map(i=>rotate(mapping.rotationsCartesian[i],d))))<3)throw Error('Site-symmetry displacement directions do not span three dimensions.');
      siteMaps.push({atom,indices:site});
      for(const d of best)for(const sign of [1,-1])displacements.push({id:displacements.length,atom,vector:d.map(x=>x/norm(d)*settings.displacement*sign)});
    }
    const masses=primitive.atoms.map(a=>root.MacerAtomicMasses[S.atomicNumber(a.element)]);
    if(masses.some(m=>!Number.isFinite(m)||m<=0))throw Error('An atomic mass is unavailable for this structure.');
    const bandPath=settings.pathMode==='auto'?root.PhononPath.automatic(primitive,moyo,kernel,settings.symprec,settings.samples):path(settings.path,settings.samples);
    const nac=settings.nacEnabled?root.PhononNac.parse(settings.born,primitive,pm,settings.nacMethod):null;
    const bornOrder=[];const bornSeen=new Set();for(let i=0;i<primitive.atoms.length;i++)if(!bornSeen.has(i)){bornOrder.push({index:i,element:primitive.atoms[i].element});pm.forwardAtomPermutations.forEach(p=>bornSeen.add(p[i]));}
    return {schema:'macer-phonon-plan-v1',primitive,supercell,primitiveIndices,repeat,representatives,displacements,siteMaps,mapping,masses,path:bandPath,nac,bornOrder,spaceGroup:dataset.number,settings,input:structure,validation:{state:'preview',message:'Numerical validation in progress',symmetry:'Moyo 0.21.0',fcExpansion:'all-valid-operation average; phonopy-order parity remains open'}};
  }
  function displaced(plan,id){const d=plan.displacements[id];if(!d)throw Error('Unknown displacement ID.');const s=engineStructure(plan.supercell);s.positions_a[d.atom]=s.positions_a[d.atom].map((x,i)=>x+d.vector[i]);return s;}
  function forceConstants(plan,records,kernel) {
    const n=plan.supercell.atoms.length,rows=[];
    for(const site of plan.siteMaps){
      const ds=plan.displacements.filter(d=>d.atom===site.atom);
      const f=ds.flatMap(d=>{const r=records[d.id];if(!r||r.forces.length!==n||!r.forces.every(v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite)))throw Error(`Missing or invalid completed force array for displacement ${d.id}.`);return r.forces.flat();});
      const inv=site.indices.flatMap(index=>{const inverse=new Array(n);plan.mapping.forwardAtomPermutations[index].forEach((target,source)=>inverse[target]=source);return inverse;});
      rows.push(...kernel.phonon_force_constants_reduced_row(n,new Float64Array(ds.flatMap(d=>d.vector)),new Float64Array(f),new Float64Array(site.indices.flatMap(i=>plan.mapping.rotationsCartesian[i])),new Uint32Array(inv)));
    }
    const raw=kernel.phonon_force_constants_expand_reduced_rows(n,new Uint32Array(plan.representatives),new Float64Array(rows),new Float64Array(plan.mapping.rotationsCartesian.flat()),new Uint32Array(plan.mapping.forwardAtomPermutations.flat()));
    const fc=kernel.phonon_symmetrize_full_fc(raw,n,1);
    if(!Array.from(fc).every(Number.isFinite))throw Error('Force-constant calculation produced non-finite values.');
    return {raw:Array.from(raw),values:Array.from(fc),symmetrization:'phonopy translational/pair-exchange level 1'};
  }
  function shortestVectors(plan) {
    const np=plan.primitive.atoms.length,ns=plan.supercell.atoms.length,cell=plan.supercell.cell,primitive=plan.primitive.cell;
    const vol=Math.abs(dot(cell[0],cross(cell[1],cell[2]))),heights=cell.map((_,i)=>vol/norm(cross(cell[(i+1)%3],cell[(i+2)%3])));
    const vectors=[],multiplicity=[];
    for(let k=0;k<ns;k++)for(let i=0;i<np;i++){
      const delta=plan.supercell.atoms[k].position.map((x,a)=>x-plan.primitive.atoms[i].position[a]);
      const frac=S.fractional(delta,cell),nearest=frac.map(Math.round),trial=delta.map((x,a)=>x-S.cartesian(nearest,cell)[a]),upper=norm(trial)+1e-8;
      const lo=frac.map((x,a)=>Math.ceil(x-upper/heights[a])),hi=frac.map((x,a)=>Math.floor(x+upper/heights[a]));
      let best=Infinity,found=[];
      const candidates=(hi[0]-lo[0]+1)*(hi[1]-lo[1]+1)*(hi[2]-lo[2]+1);
      if(candidates>200000)throw Error('Cell is too ill-conditioned for shortest-vector enumeration.');
      for(let a=lo[0];a<=hi[0];a++)for(let b=lo[1];b<=hi[1];b++)for(let c=lo[2];c<=hi[2];c++){
        const shift=S.cartesian([a,b,c],cell),v=delta.map((x,j)=>x-shift[j]),r=norm(v);
        if(r<best-1e-8){best=r;found=[v];}else if(Math.abs(r-best)<1e-8)found.push(v);
      }
      if(!found.length)throw Error('No shortest periodic vector found.');
      multiplicity.push(found.length,vectors.length/3);found.forEach(v=>vectors.push(...S.fractional(v,primitive)));
    }
    return {vectors,multiplicity};
  }
  async function bands(plan,fc,kernel,onProgress=()=>{}) {
    const np=plan.primitive.atoms.length,n=np*3,ns=plan.supercell.atoms.length,sv=shortestVectors(plan),qpoints=[],segments=[];
    const reciprocal=[0,1,2].map(a=>S.fractional([Number(a===0),Number(a===1),Number(a===2)],plan.primitive.cell));
    const qcart=q=>[0,1,2].map(a=>dot(reciprocal[a],q));
    const nac=await root.PhononNac?.prepare(plan,fc,kernel,sv,(done,total)=>onProgress(done,total,'NAC preparation'));
    const pathSegments=plan.path.segments||plan.path.points.slice(0,-1).map((p,i)=>[p,plan.path.points[i+1]]);
    let distance=0,last=null;
    for(let segment=0;segment<pathSegments.length;segment++){
      const start=qpoints.length,[A,B]=pathSegments[segment];last=null;
      for(let j=0;j<plan.path.samples;j++){
        const q=A.q.map((x,a)=>x+(B.q[a]-x)*j/(plan.path.samples-1));
        if(last)distance+=norm(qcart(q.map((x,a)=>x-last[a])));last=q;
        const isGamma=norm(qcart(q))<1e-5;
        const direction=isGamma?(plan.settings.nacDirection||B.q.map((x,a)=>x-A.q[a])):null;
        const matrix=nac?nac.matrix(q,direction):kernel.phonon_dynamical_matrix_at_q(new Float64Array(fc.values),new Float64Array(q),new Float64Array(sv.vectors),new Uint32Array(sv.multiplicity),new Float64Array(plan.masses),new Uint32Array(plan.primitiveIndices),new Uint32Array(Array.from({length:np},(_,i)=>i)),np,ns);
        const eig=kernel.phonon_eigenpairs(matrix,n);
        const branches=Array.from({length:n},(_,mode)=>({frequencyTHz:Math.sign(eig[mode])*Math.sqrt(Math.abs(eig[mode]))*15.633302300230191,eigenvector:Array.from({length:np},(_,atom)=>Array.from({length:3},(_,axis)=>{const k=n+((atom*3+axis)*n+mode)*2;return [eig[k],eig[k+1]];}))}));
        if(branches.some(b=>!Number.isFinite(b.frequencyTHz)))throw Error('Band calculation produced a non-finite frequency.');
        qpoints.push({q,distance,...(nac&&direction?{nacDirection:direction}:{}),label:j===0?A.label:j===plan.path.samples-1?B.label:'',bands:branches});
        onProgress(qpoints.length,pathSegments.length*plan.path.samples,'Bands');
        if(j%8===0)await new Promise(resolve=>setTimeout(resolve,0));
      }
      segments.push({start,end:qpoints.length-1,labels:[A.label,B.label]});
    }
    return {lattice:plan.primitive.cell,atoms:plan.primitive.atoms.map((a,i)=>({element:a.element,fractional:S.fractional(a.position,plan.primitive.cell),mass:plan.masses[i]})),qpoints,segments,hasEigenvectors:true,units:'THz',calculator:'vasp',execution:plan.execution||null,path:plan.path,nac:nac?{method:nac.method,born:nac.born,dielectric:nac.dielectric,factor:plan.nac.factor,neutralityResidual:nac.neutralityResidual,gCutoff:nac.gCutoff,lambda:nac.lambda,gPoints:nac.gPoints}:null,validation:plan.validation};
  }
  function yamlObject(result){return {calculator:'vasp',natom:result.atoms.length,lattice:result.lattice,points:result.atoms.map(a=>({symbol:a.element,coordinates:a.fractional,mass:a.mass})),nqpoint:result.qpoints.length,npath:result.segments.length,segment_nqpoint:result.segments.map(s=>s.end-s.start+1),labels:result.segments.map(s=>s.labels),phonon:result.qpoints.map(p=>({'q-position':p.q,distance:p.distance,...(p.nacDirection?{macer_nac_direction:p.nacDirection}:{}),band:p.bands.map(b=>({frequency:b.frequencyTHz,eigenvector:b.eigenvector}))})),macer_execution:result.execution||null,macer_qpath:result.path||null,macer_nac:result.nac||null,macer_validation:result.validation};}
  root.PhononEngine={plan,displaced,forceConstants,bands,yamlObject,engineStructure,shortestVectors};
  if(typeof module==='object'&&module.exports)module.exports=root.PhononEngine;
})(globalThis);
