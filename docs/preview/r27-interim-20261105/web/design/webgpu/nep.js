import {GpuTensors} from './tensor.js';

// NEP4-ZBL inference translated from the analytic equations implemented in
// crates/nep. Rust supplies only validated model arrays and periodic neighbors.
// Forward-mode edge derivatives and reverse invariant/network contractions are
// analytic; neither coordinate finite differences nor CPU inference are used.
const matrix=(v,n,w)=>Array.from({length:n},(_,i)=>Array.from(v.slice(i*w,(i+1)*w)));
const C3=[[.238732414637843,.119366207318922,.119366207318922],[.099471839432435,.596831036594608,.596831036594608,.149207759148652,.149207759148652],[.139260575205408,.104445431404056,.104445431404056,1.044454314040563,1.044454314040563,.174075719006761,.174075719006761],[.011190581936149,.223811638722978,.223811638722978,.111905819361489,.111905819361489,1.566681471060845,1.566681471060845,.195835183882606,.195835183882606]];
const dual=`
struct D {v:f32,d:vec3<f32>}
fn dc(v:f32)->D{return D(v,vec3<f32>(0.0));}
fn da(a:D,b:D)->D{return D(a.v+b.v,a.d+b.d);}
fn db(a:D,b:D)->D{return D(a.v-b.v,a.d-b.d);}
fn ds(a:D,b:f32)->D{return D(a.v*b,a.d*b);}
fn dm(a:D,b:D)->D{return D(a.v*b.v,a.d*b.v+b.d*a.v);}
fn dd(a:D,b:D)->D{return D(a.v/b.v,(a.d-a.v/b.v*b.d)/b.v);}
fn cs(a:D)->D{return D(cos(a.v),-sin(a.v)*a.d);}
fn harmonic(k:u32,x:D,y:D,z:D)->D{
 let xx=dm(x,x);let yy=dm(y,y);let zz=dm(z,z);let xy=dm(x,y);
 let x3=dm(xx,x);let y3=dm(yy,y);let z3=dm(zz,z);let z4=dm(zz,zz);
 switch k {
 ${[
 'z','x','y','db(ds(zz,3.0),dc(1.0))','dm(z,x)','dm(z,y)','db(xx,yy)','ds(xy,2.0)',
 'db(ds(z3,5.0),ds(z,3.0))','dm(db(ds(zz,5.0),dc(1.0)),x)','dm(db(ds(zz,5.0),dc(1.0)),y)',
 'dm(z,db(xx,yy))','ds(dm(z,xy),2.0)','db(x3,ds(dm(x,yy),3.0))','db(ds(dm(xx,y),3.0),y3)',
 'da(db(ds(z4,35.0),ds(zz,30.0)),dc(3.0))','dm(db(ds(z3,7.0),ds(z,3.0)),x)','dm(db(ds(z3,7.0),ds(z,3.0)),y)',
 'dm(db(ds(zz,7.0),dc(1.0)),db(xx,yy))','ds(dm(db(ds(zz,7.0),dc(1.0)),xy),2.0)',
 'dm(z,db(x3,ds(dm(x,yy),3.0)))','dm(z,db(ds(dm(xx,y),3.0),y3))',
 'da(db(dm(xx,xx),ds(dm(xx,yy),6.0)),dm(yy,yy))','ds(dm(xy,db(xx,yy)),4.0)',
 ].map((expr,i)=>`case ${i}u:{return ${expr};}`).join('\n')}
 default:{return dc(0.0);}}
}`;
const invariants=`
struct Q {v:f32,p:array<f32,24>}
fn invariant(group:u32,s:array<f32,24>)->Q{
 var q:Q;q.v=0.0;for(var k=0u;k<24u;k++){q.p[k]=0.0;}
 switch group{
 ${C3.map((coefficients,g)=>`case ${g}u:{${coefficients.map((c,k)=>{const j=(g+1)**2-1+k,w=c*(k===0?1:2);return `q.v+=${w}*s[${j}]*s[${j}];q.p[${j}]=${2*w}*s[${j}];`;}).join('')}}`).join('\n')}
 case 4u:{
 let a=-0.007499480826664;let b=-0.134990654879954;let c=0.067495327439977;let d=0.404971964639861;let e=-0.809943929279723;
 q.v=a*s[3]*s[3]*s[3]+b*s[3]*(s[4]*s[4]+s[5]*s[5])+c*s[3]*(s[6]*s[6]+s[7]*s[7])+d*s[6]*(s[5]*s[5]-s[4]*s[4])+e*s[4]*s[5]*s[7];
 q.p[3]=3.0*a*s[3]*s[3]+b*(s[4]*s[4]+s[5]*s[5])+c*(s[6]*s[6]+s[7]*s[7]);
 q.p[4]=2.0*b*s[3]*s[4]-2.0*d*s[6]*s[4]+e*s[5]*s[7];
 q.p[5]=2.0*b*s[3]*s[5]+2.0*d*s[6]*s[5]+e*s[4]*s[7];
 q.p[6]=2.0*c*s[3]*s[6]+d*(s[5]*s[5]-s[4]*s[4]);q.p[7]=2.0*c*s[3]*s[7]+e*s[4]*s[5];}
 case 5u:{
 let a=s[0]*s[0];let b=s[1]*s[1]+s[2]*s[2];
 q.v=0.026596810706114*a*a+0.053193621412227*a*b+0.026596810706114*b*b;
 q.p[0]=4.0*0.026596810706114*s[0]*s[0]*s[0]+2.0*0.053193621412227*s[0]*b;
 q.p[1]=2.0*0.053193621412227*a*s[1]+4.0*0.026596810706114*b*s[1];
 q.p[2]=2.0*0.053193621412227*a*s[2]+4.0*0.026596810706114*b*s[2];}
 default:{} }
 return q;
}`;

export class NepWebGpu {
 static async create(cpu,{timestampQueries=false}={}){
  const meta=JSON.parse(cpu.webgpu_model_json());
  if(meta.sha256!=='75168ece02e840e4a32644f982b78d43cba697f5b64b4c8134ab66c7a8c28be1'||meta.descriptor_count!==35||meta.hidden_neurons!==80||meta.neural_count!==263441||meta.atomic_numbers.length!==89||JSON.stringify(meta.cutoff_a)!=='[6,5]'||JSON.stringify(meta.zbl_transition_a)!=='[1,2]'||JSON.stringify(meta.n_max)!=='[4,4]'||JSON.stringify(meta.basis_size)!=='[8,8]'||JSON.stringify(meta.l_max)!=='[4,2,1]')throw Error('WebGPU NEP requires the pinned NEP89 architecture');
  const rt=await GpuTensors.create({timestampQueries});
  try{return new NepWebGpu(rt,cpu,meta);}catch(error){rt.destroy();throw error;}
 }
 constructor(rt,cpu,meta){
  this.rt=rt;this.cpu=cpu;this.meta=meta;
  const parameters=cpu.webgpu_parameters_f32(),scales=cpu.webgpu_scales_f32();
  if(parameters.length!==976331||scales.length!==35)throw Error('invalid NEP89 GPU parameters');
  this.parameters=rt.tensor(parameters,parameters.length,1,false,true);
  this.scales=rt.tensor(scales,35,1,false,true);
 }
 createFixedCellBatchGraph(structure){
  if(!Array.isArray(structure.pbc)||!structure.pbc.every(Boolean)||!Array.isArray(structure.cell_a))
   throw new Error('NEP device FIRE batching requires a fully periodic fixed cell');
  const graph=JSON.parse(this.cpu.webgpu_graph_json(JSON.stringify(structure)));
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const dot=(a,b)=>a.reduce((sum,value,index)=>sum+value*b[index],0);
  const cell=structure.cell_a,volume=dot(cell[0],cross(cell[1],cell[2]));
  if(!Number.isFinite(volume)||Math.abs(volume)<1e-12)throw new Error('invalid NEP batch cell');
  const reciprocal=[cross(cell[1],cell[2]),cross(cell[2],cell[0]),cross(cell[0],cell[1])].map(row=>row.map(value=>value/volume));
  const image_offsets=graph.centers.map((center,edge)=>{
   const neighbor=graph.neighbors[edge],delta=structure.positions_a[neighbor].map((value,axis)=>value-structure.positions_a[center][axis]);
   const difference=graph.displacements_a[edge].map((value,axis)=>value-delta[axis]);
   const image=reciprocal.map(row=>Math.round(dot(difference,row)));
   const reconstructed=delta.map((value,axis)=>value+image.reduce((sum,q,k)=>sum+q*cell[k][axis],0));
   const scale=Math.max(1,...structure.positions_a.flat().map(Math.abs),...cell.flat().map(Math.abs));
   if(image.some(value=>!Number.isSafeInteger(value))||reconstructed.some((value,axis)=>Math.abs(value-graph.displacements_a[edge][axis])>2e-7*scale))
    throw new Error(`NEP batch graph image reconstruction failed at edge ${edge}`);
   return image;
  });
  const topology_key=JSON.stringify([graph.atomic_numbers,graph.types,graph.centers,graph.neighbors,graph.center_offsets,image_offsets]);
  return {...graph,image_offsets,topology_key};
 }
 async evaluate(structure,{batch=false,graph:providedGraph=null,positions:batchPositions=null,cell:batchCell=null}={}){
  const started=performance.now(),graph=providedGraph||JSON.parse(this.cpu.webgpu_graph_json(JSON.stringify(structure)));
  const n=graph.types.length,e=graph.centers.length,rt=this.rt,model=this.meta;
  const graphMs=performance.now()-started;
  if(batch){
   if(!rt.evaluationActive||!batchPositions||batchPositions.rows!==n||batchPositions.cols!==3
      ||!batchCell||batchCell.rows!==3||batchCell.cols!==3)
    throw new Error('NEP batched evaluation requires an active batch and GPU position/cell tensors');
   if(!graph.image_offsets||graph.image_offsets.length!==e)throw new Error('NEP fixed-cell batch image offsets are missing');
  }else rt.begin({maxRequestedBufferBytes:128*1024*1024});
  try{
   const centers=rt.indices(graph.centers,n),neighbors=rt.indices(graph.neighbors,n),ptr=rt.indices(graph.center_offsets,e+1);
   const types=rt.indices(graph.types,89),numbers=rt.tensor(graph.atomic_numbers,n,1);
   const imageTensor=batch?rt.tensor(graph.image_offsets.flat(),e,3):null;
   const vectors=batch?rt.kernel([batchPositions,centers,neighbors,imageTensor,batchCell],e,3,`
    let center=x1[row]*3u;let neighbor=x2[row]*3u;
    y[i]=x0[neighbor+col]-x0[center+col]+x3[row*3u]*x4[col]+x3[row*3u+1u]*x4[3u+col]+x3[row*3u+2u]*x4[6u+col];`):rt.tensor(graph.displacements_a.flat(),e,3);
   const features=rt.kernel([vectors,centers,neighbors,types,this.parameters],e,500,`
    if(col%4u!=0u){return;}let moment=col/4u;
    let v=vec3<f32>(x0[row*3u],x0[row*3u+1u],x0[row*3u+2u]);let length=length(v);
    let r=D(length,v/length);var cutoff=6.0;var order=moment;var angular=false;
    if(moment>=5u){angular=true;cutoff=5.0;order=(moment-5u)/24u;}
    var value=dc(0.0);
    if(length<cutoff){
     let scaled=db(ds(r,1.0/cutoff),dc(1.0));let a=db(ds(dm(scaled,scaled),2.0),dc(1.0));
     let fc=ds(da(dc(1.0),cs(ds(r,3.141592653589793/cutoff))),0.5);
     let pair=x3[x1[row]]*89u+x3[x2[row]];
     var offset=${model.neural_count}u;if(angular){offset+=356445u;}
     var previous=dc(1.0);var current=a;
     for(var k=0u;k<9u;k++){
      var t=dc(1.0);if(k==1u){t=a;}else if(k>=2u){t=db(ds(dm(a,current),2.0),previous);previous=current;current=t;}
      let basis=ds(dm(da(t,dc(1.0)),fc),0.5);
      value=da(value,ds(basis,x4[offset+(order*9u+k)*7921u+pair]));
     }
     if(angular){
      let x=dd(D(v.x,vec3<f32>(1.0,0.0,0.0)),r);let yv=dd(D(v.y,vec3<f32>(0.0,1.0,0.0)),r);let z=dd(D(v.z,vec3<f32>(0.0,0.0,1.0)),r);
      value=dm(value,harmonic((moment-5u)%24u,x,yv,z));
     }
    }
    y[i]=value.v;y[i+1u]=value.d.x;y[i+2u]=value.d.y;y[i+3u]=value.d.z;`,false,dual);
   const moments=rt.kernel([features,ptr],n,125,`var value=0.0;for(var edge=x1[row];edge<x1[row+1u];edge++){value+=x0[edge*500u+col*4u];}y[i]=value;`);
   const descriptors=rt.kernel([moments,this.scales],n,35,`
    if(col<5u){y[i]=x0[row*125u+col]*x1[col];return;}
    let g=(col-5u)/5u;let order=(col-5u)%5u;var s:array<f32,24>;
    for(var k=0u;k<24u;k++){s[k]=x0[row*125u+5u+order*24u+k];}
    y[i]=invariant(g,s).v*x1[col];`,false,invariants);
   const hidden=rt.kernel([descriptors,types,this.parameters],n,80,`
    let base=x1[row]*2960u;var value=-x2[base+2800u+col];
    for(var k=0u;k<35u;k++){value+=x0[row*35u+k]*x2[base+col*35u+k];}y[i]=tanh(value);`);
   const descriptorGradient=rt.kernel([hidden,types,this.parameters],n,35,`
    let base=x1[row]*2960u;var value=0.0;
    for(var k=0u;k<80u;k++){let a=x0[row*80u+k];value+=x2[base+2880u+k]*(1.0-a*a)*x2[base+k*35u+col];}y[i]=value;`);
   const momentGradient=rt.kernel([moments,descriptorGradient,this.scales],n,125,`
    if(col<5u){y[i]=x1[row*35u+col]*x2[col];return;}
    let order=(col-5u)/24u;let k=(col-5u)%24u;var s:array<f32,24>;
    for(var j=0u;j<24u;j++){s[j]=x0[row*125u+5u+order*24u+j];}
    var value=0.0;for(var g=0u;g<6u;g++){let q=5u+g*5u+order;value+=invariant(g,s).p[k]*x1[row*35u+q]*x2[q];}y[i]=value;`,false,invariants);
   const zbl=rt.kernel([vectors,centers,neighbors,numbers],e,2,`
    let r=length(vec3<f32>(x0[row*3u],x0[row*3u+1u],x0[row*3u+2u]));
    if(r>=2.0){y[i]=0.0;return;}
    let za=x3[x1[row]];let zb=x3[x2[row]];let screening=2.134563*(pow(za,0.23)+pow(zb,0.23));
    let a=array<f32,4>(0.18175,0.50986,0.28022,0.02817);let b=array<f32,4>(3.1998,0.94229,0.4029,0.20162);
    var potential=0.0;var derivative=0.0;for(var k=0u;k<4u;k++){let term=a[k]*exp(-b[k]*screening*r);potential+=term;derivative-=b[k]*screening*term;}
    var fc=1.0;var df=0.0;if(r>=1.0){let phase=3.141592653589793*(r-1.0);fc=0.5*(1.0+cos(phase));df=-0.5*sin(phase)*3.141592653589793;}
    let prefactor=0.5*14.399645*za*zb;
    if(col==0u){y[i]=prefactor*potential/r*fc;}else{y[i]=prefactor*((derivative/r-potential/(r*r))*fc+potential/r*df);}`);
   const edgeGradient=rt.kernel([features,momentGradient,centers,zbl,vectors],e,3,`
    var value=0.0;for(var k=0u;k<125u;k++){value+=x0[row*500u+k*4u+1u+col]*x1[x2[row]*125u+k];}
    let r=length(vec3<f32>(x4[row*3u],x4[row*3u+1u],x4[row*3u+2u]));y[i]=value+x3[row*2u+1u]*x4[row*3u+col]/r;`);
   const from=rt.scatter(edgeGradient,centers,n),to=rt.scatter(edgeGradient,neighbors,n);
   const forces=rt.kernel([from,to],n,3,'y[i]=x0[i]-x1[i];');
   const edgeVirial=rt.kernel([vectors,edgeGradient],e,9,'y[i]=-x0[row*3u+col/3u]*x1[row*3u+col%3u];');
   const virials=rt.scatter(edgeVirial,neighbors,n);
   const energies=rt.kernel([hidden,types,this.parameters,zbl,ptr],n,1,`
    var value=-x2[263440u];let base=x1[row]*2960u;
    for(var k=0u;k<80u;k++){value+=x0[row*80u+k]*x2[base+2880u+k];}
    for(var edge=x4[row];edge<x4[row+1u];edge++){value+=x3[edge*2u];}y[i]=value;`);
   const cell=structure.cell_a,periodic=structure.pbc.some(Boolean);
   const volume=periodic?Math.abs(cell[0][0]*(cell[1][1]*cell[2][2]-cell[1][2]*cell[2][1])-cell[0][1]*(cell[1][0]*cell[2][2]-cell[1][2]*cell[2][0])+cell[0][2]*(cell[1][0]*cell[2][1]-cell[1][1]*cell[2][0])):1;
   const batchStress=batch?rt.kernel([virials,batchCell],3,3,`
    let volume=abs(x1[0]*(x1[4]*x1[8]-x1[5]*x1[7])-x1[1]*(x1[3]*x1[8]-x1[5]*x1[6])+x1[2]*(x1[3]*x1[7]-x1[4]*x1[6]));
    var value=0.0;for(var atom=0u;atom<${n}u;atom++){value-=x0[atom*9u+i];}y[i]=value/volume;`):null;
   // Energies and virials are already required outputs. Reduce them on the
   // host after the single batched readback instead of dispatching two more
   // tiny GPU kernels (which are launch/synchronization overhead at this size).
   if(batch)return {forces,energies,virials,stress:batchStress,positions:batchPositions,cell:batchCell,volume,n,periodic,started,graph_ms:graphMs};
   const readback=[forces,energies,virials];if(this.traceFeatures)readback.push(descriptors,moments);
   const values=await rt.finish(readback);
   const energyEv=values[1].reduce((sum,value)=>sum+value,0);
   const perAtomVirial=matrix(values[2],n,9);
   const stressEvPerA3=periodic?Array.from({length:9},(_,component)=>-
    perAtomVirial.reduce((sum,row)=>sum+row[component],0)/volume):Array(9).fill(0);
   if(this.traceFeatures)this.lastFeatures={descriptors:matrix(values[3],n,35),moments:matrix(values[4],n,125)};
   this.lastTiming={total_ms:performance.now()-started,feature_ms:graphMs,geometry_backend:'webgpu-nep-analytic',atoms:n,edges:e,gpu_finish:rt.lastFinishTiming,gpu_memory:rt.lastMemory};
   return {energy_ev:energyEv,forces_ev_per_a:matrix(values[0],n,3),stress_ev_per_a3:matrix(stressEvPerA3,3,3),energies_ev:Array.from(values[1]),per_atom_virial_ev:perAtomVirial,...(periodic?{stresses_ev_per_a3:perAtomVirial.map(row=>matrix(row.map(v=>-v/volume),3,3))}:{})};
  }catch(error){if(rt.evaluationActive)await rt.abort();throw error;}
 }
 destroy(){this.rt.destroy();}
}
