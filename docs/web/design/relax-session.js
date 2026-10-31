'use strict';
// Pure geometry/session helpers; no storage, model loading or optimizer state.
globalThis.RelaxSession=Object.freeze({
  action(state){return state==='converged'?'Use final structure as input':['max_steps','stopped'].includes(state)?'Continue from final structure':state==='failed'?'Use last completed structure as input':'Use final structure as input';},
  geometry(run,snapshot){
    const s=snapshot.structure,source=run.input;
    return JSON.parse(JSON.stringify({comment:source.comment||'Relax result',cell:s.pbc.some(Boolean)?s.cell_a:null,pbc:s.pbc,
      selective:source.atoms.some(a=>(a.mask||[true,true,true]).some(v=>!v)),format:s.pbc.some(Boolean)?'poscar':'xyz',
      atoms:s.atomic_numbers.map((z,i)=>({element:Structures.elementSymbol(z),position:s.positions_a[i],mask:source.atoms[i].mask||[true,true,true]}))}));
  },
  validateProject(p){
    const fail=()=>{throw Error('Invalid Relax project. No input or run records were replaced.');};
    if(p?.schema!=='macer-relax-session-project-v1'||!Array.isArray(p.runs)||!p.input||!['poscar','cif','xyz'].includes(p.input.format)||typeof p.input.text!=='string')fail();
    const ids=new Set(),finite=x=>typeof x==='number'&&Number.isFinite(x),mask=m=>Array.isArray(m)&&m.length===3&&m.every(v=>typeof v==='boolean');
    for(const r of p.runs){
      if(!Number.isSafeInteger(r.id)||r.id<1||ids.has(r.id)||!['converged','max_steps','stopped','failed','single_point'].includes(r.state)||!Array.isArray(r.history)||r.history.length>501||!r.model?.model_id||!r.settings?.dof||!r.input?.atoms?.length||!finite(r.elapsed))fail();ids.add(r.id);
      if(!finite(r.settings.forceTolerance)||r.settings.forceTolerance<=0||!finite(r.settings.stressTolerance)||r.settings.stressTolerance<=0||!finite(r.settings.pressure))fail();
      const n=r.input.atoms.length;
      if(!r.input.atoms.every(a=>Structures.atomicNumber(a.element)&&a.position?.length===3&&a.position.every(finite)&&mask(a.mask||[true,true,true])))fail();
      for(let i=0;i<r.history.length;i++){
        const s=r.history[i],g=s.structure,e=s.evaluation;
        if(!Number.isSafeInteger(s.step)||s.step<0||(i&&s.step<=r.history[i-1].step)||!g||g.atomic_numbers?.length!==n||g.positions_a?.length!==n||!mask(g.pbc)||!finite(e?.energy_ev)||!finite(s.max_force_ev_per_a))fail();
        if(!g.atomic_numbers.every((z,j)=>z===Structures.atomicNumber(r.input.atoms[j].element))||!g.positions_a.every(a=>a.length===3&&a.every(finite)))fail();
        if(!Array.isArray(g.cell_a)||g.cell_a.length!==3||!g.cell_a.every(a=>a.length===3&&a.every(finite))||!Array.isArray(e.forces_ev_per_a)||e.forces_ev_per_a.length!==n||!e.forces_ev_per_a.every(a=>a.length===3&&a.every(finite)))fail();
        if(g.pbc.some(Boolean)&&(!e.stress_ev_per_a3||e.stress_ev_per_a3.length!==3||!e.stress_ev_per_a3.every(a=>a.length===3&&a.every(finite))||Math.abs(Structures.determinant(g.cell_a))<1e-12))fail();
      }
    }
    if(p.selectedRun!=null&&!ids.has(p.selectedRun))fail();
    return JSON.parse(JSON.stringify(p));
  }
});
