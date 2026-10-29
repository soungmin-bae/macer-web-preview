import { GpuTensors } from './tensor.js';
import { GpuGeometry } from './geometry.js';

const matrix = (data, rows, cols) => Array.from({ length: rows }, (_, i) => Array.from(data.slice(i*cols, (i+1)*cols)));

// Geometry, the frozen network, analytic reverse derivatives and E/F/stress
// aggregation run on GPU. Rust supplies ordered images and the FIRE session.
// geometryMode='wasm' retains the first hybrid path as an explicit oracle.
export class MatterSimWebGpu {
  static async create(manifestBytes, weightsBytes, cpuEngine, { geometryMode = 'gpu', timestampQueries = false } = {}) {
    const started = performance.now();
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    if (manifest.model_id !== 'mattersim-v1.0.0-1M') throw new Error('WebGPU currently requires MatterSim 1M');
    const bytes = weightsBytes instanceof Uint8Array ? weightsBytes : new Uint8Array(weightsBytes);
    const headerLength = Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true));
    if (!Number.isSafeInteger(headerLength) || headerLength < 2 || headerLength+8 > bytes.length) throw new Error('invalid safetensors header');
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8+headerLength)));
    const rt = await GpuTensors.create({ timestampQueries });
    const weights = new Map();
    try {
      for (const spec of manifest.tensors) {
        const tensor = header[spec.name];
        if (tensor?.dtype !== 'F32' || JSON.stringify(tensor.shape) !== JSON.stringify(spec.shape)) throw new Error(`invalid GPU model tensor ${spec.name}`);
        const [start, end] = tensor.data_offsets;
        const count = spec.shape.reduce((a,b) => a*b, 1);
        if (end-start !== count*4 || start < 0 || end+8+headerLength > bytes.length) throw new Error('invalid safetensors tensor bounds');
        const copy = bytes.slice(8+headerLength+start, 8+headerLength+end);
        const data = new Float32Array(copy.buffer);
        if (!data.every(Number.isFinite)) throw new Error('model contains non-finite weights');
        const [rows, cols] = spec.shape.length === 2 ? spec.shape : [count, 1];
        weights.set(spec.name, rt.tensor(data, rows, cols, false, true));
      }
      // Queue writes are ordered before the later evaluation submission, so
      // model setup need not wait for a separate queue-completion boundary.
      const constants = geometryMode === 'gpu' ? JSON.parse(cpuEngine.webgpu_geometry_constants_json()) : null;
      const evaluator = new MatterSimWebGpu(rt, weights, cpuEngine, manifest.model_args.num_blocks, constants, geometryMode);
      evaluator.prepareMs = performance.now()-started;
      return evaluator;
    } catch (error) { rt.destroy(); throw error; }
  }

  constructor(runtime, weights, cpuEngine, blocks, constants, geometryMode) {
    this.rt = runtime; this.weights = weights; this.cpu = cpuEngine; this.blocks = blocks;
    this.constants = constants; this.geometryMode = geometryMode;
  }

  linear(x, prefix) {
    const weight = this.weights.get(`${prefix}.linear.weight`);
    if (!weight) throw new Error(`GPU model lacks ${prefix}`);
    return this.rt.linear(x, weight, this.weights.get(`${prefix}.linear.bias`));
  }

  gated(x, prefix, layers) {
    const rt = this.rt;
    let g = x, sigma = x;
    for (let i=0; i<layers; i++) {
      g = this.linear(g, `${prefix}.g.${i}`);
      sigma = this.linear(sigma, `${prefix}.sigma.${i}`);
      const final = i+1 === layers;
      if (!final) {
        g = rt.activation(g, 'silu');
        sigma = rt.activation(sigma, 'silu');
        continue;
      }
      const gateActivation = final && prefix === 'final' ? 'identity' : 'silu';
      const signalActivation = 'sigmoid';
      g = rt.gatedProduct(g, sigma, gateActivation, signalActivation);
    }
    return g;
  }

  async evaluate(structure) {
    const began = performance.now(), structureJson = JSON.stringify(structure);
    const features = this.geometryMode === 'gpu'
      ? {graph: JSON.parse(this.cpu.webgpu_ordered_graph_json(structureJson))}
      : JSON.parse(this.cpu.webgpu_features_json(structureJson));
    const featureMs = performance.now()-began;
    const graph = features.graph, n = graph.atomic_numbers.length, e = graph.source.length, t = graph.triple_first.length;
    const rt = this.rt;
    rt.begin({deferOutputs:true});
    const graphBuildStarted = performance.now();
    try {
      const geometry = this.geometryMode === 'gpu' ? new GpuGeometry(rt,graph,this.constants) : null;
      const rbf = geometry?.rbf || rt.tensor(features.rbf.flat(), e, 4, true);
      const sbf = geometry?.sbf || rt.tensor(features.sbf.flat(), t, 16, true);
      const cutoff = geometry?.cutoff || rt.tensor(features.cutoff.flat(), t, 1, true);
      const source = geometry?.source || rt.indices(graph.source, n), dest = geometry?.dest || rt.indices(graph.destination, n);
      const first = geometry?.first || rt.indices(graph.triple_first, e);
      const secondSources = rt.indices(graph.triple_second.map(i => graph.source[i]), n);
      const species = rt.indices(graph.atomic_numbers, this.weights.get('normalizer.scale').rows);
      const onehot = new Float32Array(n*95);
      graph.atomic_numbers.forEach((z,i) => { onehot[i*95+z] = 1; });
      let atom = this.linear(rt.tensor(onehot,n,95), 'atom_embedding.mlp.0');
      let edge = rt.activation(this.linear(rbf, 'edge_encoder.mlp.0'), 'silu');
      for (let i=0; i<this.blocks; i++) {
        const prefix = `graph_conv.${i}`;
        const gate = rt.gather(rt.activation(this.linear(atom, `${prefix}.three_body.atom_mlp`), 'sigmoid'), secondSources);
        const triple = rt.mul(rt.mul(sbf, gate), cutoff);
        edge = rt.add(edge, this.gated(rt.scatter(triple, first, e), `${prefix}.three_body.edge_gate_mlp`, 1));
        const from = rt.gather(atom, source), to = rt.gather(atom, dest);
        const update = this.gated(rt.cat(from,to,edge), `${prefix}.gated_mlp_edge`, 2);
        edge = rt.add(edge, rt.mul(update, this.linear(rbf, `${prefix}.edge_layer_edge`)));
        const atomGate = rt.activation(this.linear(rbf, `${prefix}.edge_layer_atom`), 'silu');
        const messages = rt.mul(this.gated(rt.cat(from,to,edge), `${prefix}.gated_mlp_atom`, 2), atomGate);
        atom = rt.add(atom, rt.scatter(messages, source, n));
      }
      const atomic = this.gated(atom,'final',3);
      const scale = rt.gather(this.weights.get('normalizer.scale'), species);
      const shift = rt.gather(this.weights.get('normalizer.shift'), species);
      const energy = rt.scaledEnergySum(atomic,scale,shift);
      rt.backward(energy);
      const grad = x => x.grad || rt.tensor(new Float32Array(x.size),x.rows,x.cols);
      const outputs = geometry?.outputs(structure.pbc.some(Boolean));
      const readback = outputs ? [energy,outputs.forces,outputs.stress] : [energy,grad(rbf),grad(sbf),grad(cutoff)];
      if (this.traceFeatures) readback.push(rbf,sbf,cutoff);
      const graphBuildMs = performance.now()-graphBuildStarted;
      const values = await rt.finish(readback);
      if (this.traceFeatures) {
        const offset = outputs ? 3 : 4;
        this.lastFeatures = { rbf:matrix(values[offset],e,4),sbf:matrix(values[offset+1],t,16),cutoff:matrix(values[offset+2],t,1) };
      }
      const gpuNetworkMs = performance.now()-began-featureMs;
      const backwardStart = performance.now();
      const evaluation = outputs ? {energy_ev:values[0][0],forces_ev_per_a:matrix(values[1],n,3),stress_ev_per_a3:matrix(values[2],3,3)}
        : JSON.parse(this.cpu.webgpu_geometry_backward_json(structureJson,JSON.stringify({
        energy_ev: values[0][0], rbf: matrix(values[1],e,4), sbf: matrix(values[2],t,16), cutoff: matrix(values[3],t,1),
      })));
      const geometryBackwardMs = performance.now()-backwardStart;
      this.lastTiming = { total_ms: performance.now()-began, feature_ms: featureMs,
        gpu_network_encode_execute_readback_ms: gpuNetworkMs, geometry_backward_ms: geometryBackwardMs,
        host_graph_build_ms:graphBuildMs,gpu_finish:rt.lastFinishTiming,
        geometry_backend:geometry?'webgpu':'wasm',readback_bytes:readback.reduce((sum,x)=>sum+x.size*4,0),
        gpu_memory:rt.lastMemory,
        atoms:n, edges:e, triples:t, cached_pipelines:rt.pipelines.size };
      return evaluation;
    } catch (error) { await rt.abort(); throw error; }
  }

  destroy() { this.rt.destroy(); }
}
