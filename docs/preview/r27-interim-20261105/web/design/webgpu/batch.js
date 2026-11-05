import { GpuGeometryBatch } from './geometry_batch.js';

// Rust's ordered graph uses wrapped positions. FIRE keeps continuous atom
// coordinates, which may differ by a lattice image. Express the graph offsets
// in FIRE's image convention once at the beginning of each validated segment.
export function graphForContinuousPositions(graph,positions,cell) {
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const dot=(a,b)=>a.reduce((sum,value,index)=>sum+value*b[index],0);
  const reciprocal=[cross(cell[1],cell[2]),cross(cell[2],cell[0]),cross(cell[0],cell[1])];
  const volume=dot(cell[0],reciprocal[0]);
  if(!Number.isFinite(volume)||Math.abs(volume)<1e-12||positions.length!==graph.positions_a.length)
    throw new Error('invalid continuous-coordinate graph cell or atom count');
  const images=positions.map((position,index)=>{
    const delta=position.map((value,axis)=>value-graph.positions_a[index][axis]);
    const image=reciprocal.map(row=>Math.round(dot(delta,row)/volume));
    const residual=delta.map((value,axis)=>value-image.reduce((sum,q,k)=>sum+q*cell[k][axis],0));
    // Wrapped graph positions are f32, whereas the host structure is f64.
    const scale=Math.max(1,...position.map(Math.abs),...cell.flat().map(Math.abs));
    if(image.some(q=>!Number.isSafeInteger(q))||residual.some(value=>!Number.isFinite(value)||Math.abs(value)>2e-6*scale))
      throw new Error('ordered graph positions differ by more than a lattice image');
    return image;
  });
  return {...graph,offsets:graph.offsets.map((offset,index)=>offset.map((value,axis)=>
    value+images[graph.source[index]][axis]-images[graph.destination[index]][axis]))};
}

// Queue a MatterSim E/F/stress evaluation at device-resident coordinates.
// Worker batches use a fixed graph and are capped to eligible geometries.
export function enqueueGraphBatch(evaluator,graph,positions,cell=null,includeFeatures=false) {
  const rt=evaluator.rt;
  if(!rt.evaluationActive)throw new Error('batched MatterSim evaluation requires an active tensor batch');
  if(evaluator.geometryMode!=='gpu')throw new Error('batched MatterSim evaluation requires GPU geometry');
  const n=graph.atomic_numbers.length,e=graph.source.length;
  if(!positions||positions.rows!==n||positions.cols!==3||positions.dtype!=='f32')
    throw new Error('batched MatterSim positions must be an N x 3 f32 tensor');
  // Isolate this reverse pass while earlier commands and output buffers remain
  // queued in the same command encoder.
  rt.tape=[];rt.gradientTargets.clear();rt.recording=true;
  const geometry=new GpuGeometryBatch(rt,graph,evaluator.constants,positions,cell);
  const rbf=geometry.rbf,sbf=geometry.sbf,cutoff=geometry.cutoff;
  const source=geometry.source,dest=geometry.dest,first=geometry.first;
  const secondSources=rt.indices(graph.triple_second.map(i=>graph.source[i]),n);
  const species=rt.indices(graph.atomic_numbers,evaluator.weights.get('normalizer.scale').rows);
  const onehot=new Float32Array(n*95);
  graph.atomic_numbers.forEach((z,i)=>{onehot[i*95+z]=1;});
  let atom=evaluator.linear(rt.tensor(onehot,n,95),'atom_embedding.mlp.0');
  let edge=rt.activation(evaluator.linear(rbf,'edge_encoder.mlp.0'),'silu');
  for(let i=0;i<evaluator.blocks;i++){
    const prefix=`graph_conv.${i}`;
    const gate=rt.gather(rt.activation(evaluator.linear(atom,`${prefix}.three_body.atom_mlp`),'sigmoid'),secondSources);
    const triple=rt.mul(rt.mul(sbf,gate),cutoff);
    edge=rt.add(edge,evaluator.gated(rt.scatter(triple,first,e),`${prefix}.three_body.edge_gate_mlp`,1));
    const from=rt.gather(atom,source),to=rt.gather(atom,dest);
    const update=evaluator.gated(rt.cat(from,to,edge),`${prefix}.gated_mlp_edge`,2);
    edge=rt.add(edge,rt.mul(update,evaluator.linear(rbf,`${prefix}.edge_layer_edge`)));
    const atomGate=rt.activation(evaluator.linear(rbf,`${prefix}.edge_layer_atom`),'silu');
    const messages=rt.mul(evaluator.gated(rt.cat(from,to,edge),`${prefix}.gated_mlp_atom`,2),atomGate);
    atom=rt.add(atom,rt.scatter(messages,source,n));
  }
  const atomic=evaluator.gated(atom,'final',3);
  const scale=rt.gather(evaluator.weights.get('normalizer.scale'),species);
  const shift=rt.gather(evaluator.weights.get('normalizer.shift'),species);
  const energy=rt.scaledEnergySum(atomic,scale,shift);
  rt.backward(energy);
  const outputs=geometry.outputs(true);
  return {energy,forces:outputs.forces,stress:outputs.stress,
    ...(includeFeatures?{rbf,sbf,cutoff}:{})};
}
