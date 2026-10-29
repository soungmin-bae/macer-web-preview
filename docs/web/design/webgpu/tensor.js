// Small f32 WebGPU reverse-mode engine for the frozen MatterSim network.
// Model weights stay on GPU. Evaluation intermediates are released together.
export class GpuTensors {
  static async create({ timestampQueries = false } = {}) {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable in this browser. Select CPU/WASM.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter was found.');
    if (timestampQueries && !adapter.features.has('timestamp-query')) throw new Error('WebGPU adapter does not support timestamp-query');
    const device = await adapter.requestDevice({ requiredFeatures: timestampQueries ? ['timestamp-query'] : [] });
    const runtime = new GpuTensors(device, { timestampQueries });
    if(timestampQueries){
      runtime.timestampQuerySet=device.createQuerySet({type:'timestamp',count:2});
      runtime.timestampResolveBuffer=device.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
    }
    runtime.adapterInfo = adapter.info ? {
      vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      device: adapter.info.device, description: adapter.info.description,
      isFallbackAdapter: adapter.info.isFallbackAdapter ?? null,
    } : null;
    return runtime;
  }

  constructor(device, { timestampQueries = false } = {}) {
    this.device = device;
    this.timestampQueries = timestampQueries;
    this.timestampQuerySet = null;
    this.timestampResolveBuffer = null;
    this.timestampPassRecorded = false;
    this.readbackBuffer = null;
    this.readbackCapacityBytes = 0;
    this.readbackBufferCreates = 0;
    this.readbackBufferReuses = 0;
    this.readbackBufferGrows = 0;
    this.pipelines = new Map();
    this.persistent = new Set();
    this.transient = new Set();
    this.pool = new Map();
    this.bufferSizes = new Map();
    this.poolBytes = 0;
    this.poolLimitBytes = 64 * 1024 * 1024;
    this.pipelineLimit = 256;
    this.pipelineEvictions = 0;
    this.modelBytes = 0;
    this.transientBytes = 0;
    this.peakBufferBytes = 0;
    this.requestedBufferLimitBytes = null;
    this.allocatedBuffers = 0;
    this.reusedBuffers = 0;
    this.tape = [];
    this.recording = true;
    this.encoder = null;
    this.submittedCommandBuffers = 0;
    this.evaluationActive = false;
    this.scopeOpen = false;
    this.pendingPasses = [];
    this.dispatchCount = 0;
    this.computePassCount = 0;
    this.gradientTargets = new Set();
    this.gradientMergeKernels = 0;
    this.gradientMergeInputs = 0;
    this.gradientMergeDispatchesSaved = 0;
    this.gradientMergeFallbacks = 0;
    this.maxGradientFanIn = 0;
    this.timestampPassRecorded = false;
    this.lost = null;
    device.lost.then(info => { this.lost = info.message || info.reason; });
  }

  tensor(values, rows, cols, requiresGrad = false, persistent = false, dtype = 'f32') {
    const size = rows * cols;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('invalid GPU tensor shape');
    const byteSize = Math.max(4, size * 4);
    if (byteSize > this.device.limits.maxStorageBufferBindingSize) throw new Error('GPU tensor exceeds device storage limit');
    const bucket = persistent ? null : this.pool.get(byteSize);
    let buffer = bucket?.pop();
    if (buffer) {
      this.poolBytes -= byteSize; this.reusedBuffers++;
      if (!bucket.length) this.pool.delete(byteSize);
    } else {
      this.assertRequestedBufferBudget(byteSize);
      buffer = this.device.createBuffer({ size: byteSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      this.bufferSizes.set(buffer,byteSize); this.allocatedBuffers++;
    }
    (persistent ? this.persistent : this.transient).add(buffer);
    if (persistent) this.modelBytes += byteSize; else this.transientBytes += byteSize;
    this.peakBufferBytes = Math.max(this.peakBufferBytes,this.modelBytes+this.transientBytes+this.poolBytes);
    if (values !== null && values !== undefined) {
      const data = dtype === 'u32' ? Uint32Array.from(values) : Float32Array.from(values);
      if (data.length !== size) throw new Error('GPU tensor data length differs from shape');
      if (dtype === 'f32' && !data.every(Number.isFinite)) throw new Error('GPU tensor input contains NaN/Infinity');
      if (data.length) this.device.queue.writeBuffer(buffer, 0, data);
    }
    return { buffer, rows, cols, size, requiresGrad: requiresGrad && this.recording, dtype, grad: null };
  }

  view(buffer, byteOffset, rows, cols, dtype = 'f32') {
    const size=rows*cols,byteSize=size*4,bufferSize=this.bufferSizes.get(buffer);
    if(!Number.isSafeInteger(size)||size<=0||!Number.isSafeInteger(byteOffset)||byteOffset<0
        ||!bufferSize||byteOffset+byteSize>bufferSize||byteOffset%256!==0)
      throw new Error('invalid aligned GPU tensor view');
    return {buffer,bufferOffset:byteOffset,bufferSize:byteSize,rows,cols,size,requiresGrad:false,dtype,grad:null};
  }

  begin({ maxRequestedBufferBytes = null } = {}) {
    if (this.lost) throw new Error(`WebGPU device lost: ${this.lost}`);
    if (this.evaluationActive) throw new Error('GPU evaluation is already active');
    if (maxRequestedBufferBytes !== null && (!Number.isSafeInteger(maxRequestedBufferBytes) || maxRequestedBufferBytes <= 0)) {
      throw new Error('invalid requested-buffer budget');
    }
    this.requestedBufferLimitBytes = maxRequestedBufferBytes;
    const alreadyRequestedBytes = this.modelBytes + this.transientBytes + this.poolBytes + this.readbackCapacityBytes;
    if (maxRequestedBufferBytes !== null && alreadyRequestedBytes > maxRequestedBufferBytes) {
      this.requestedBufferLimitBytes = null;
      throw new Error(`existing requested WebGPU buffers exceed batch budget (${alreadyRequestedBytes} > ${maxRequestedBufferBytes} bytes)`);
    }
    this.device.pushErrorScope('validation');
    this.scopeOpen = true;
    this.evaluationActive = true;
    this.submittedCommandBuffers = 0;
    this.tape = [];
    this.recording = true;
    this.peakBufferBytes = this.modelBytes + this.poolBytes;
    this.allocationStart = this.allocatedBuffers;
    this.reuseStart = this.reusedBuffers;
    this.dispatchCount = 0;
    this.computePassCount = 0;
    this.gradientTargets.clear();
    this.gradientMergeKernels = 0;
    this.gradientMergeInputs = 0;
    this.gradientMergeDispatchesSaved = 0;
    this.gradientMergeFallbacks = 0;
    this.maxGradientFanIn = 0;
    try { this.encoder = this.device.createCommandEncoder(); }
    catch (error) {
      void this.closeScope().catch(() => {});
      this.releaseEvaluation(false);
      throw error;
    }
  }

  assertRequestedBufferBudget(additionalBytes, replacedReadbackBytes = 0) {
    if (this.requestedBufferLimitBytes === null) return;
    const currentBytes = this.modelBytes + this.transientBytes + this.poolBytes + this.readbackCapacityBytes;
    const projectedBytes = currentBytes - replacedReadbackBytes + additionalBytes;
    if (projectedBytes > this.requestedBufferLimitBytes) {
      throw new Error(`requested WebGPU buffer budget exceeded before allocation (${projectedBytes} > ${this.requestedBufferLimitBytes} bytes)`);
    }
  }

  kernel(inputs, rows, cols, body, requiresGrad = false, prelude = '') {
    const out = this.tensor(null, rows, cols, requiresGrad);
    if (!out.size) return out;
    const bindings = inputs.map((input, i) => `@group(0) @binding(${i}) var<storage, read> x${i}: array<${input.dtype}>;`).join('\n');
    const code = `${prelude}\n${bindings}\n@group(0) @binding(${inputs.length}) var<storage, read_write> y: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x; if (i >= ${out.size}u) { return; }
  let row = i / ${Math.max(cols, 1)}u; let col = i % ${Math.max(cols, 1)}u;
  ${body}
}`;
    const groups = Math.ceil(out.size / 64);
    this.dispatch(inputs, out, code, groups);
    return out;
  }

  dispatch(inputs, out, code, groupsX, groupsY = 1) {
    if (Math.max(groupsX,groupsY) > this.device.limits.maxComputeWorkgroupsPerDimension) throw new Error('GPU dispatch exceeds device limit');
    this.dispatchCount++;
    let entry = this.pipelines.get(code);
    if (entry) { this.pipelines.delete(code); this.pipelines.set(code,entry); }
    if (!entry) {
      const module = this.device.createShaderModule({ code });
      // An explicit layout also permits inputs which a derivative kernel does
      // not use (e.g. sigmoid backward reads output rather than input).
      const bindings = this.device.createBindGroupLayout({ entries: [...inputs, out].map((_,binding) => ({
        binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: binding === inputs.length ? 'storage' : 'read-only-storage' },
      })) });
      const layout = this.device.createPipelineLayout({ bindGroupLayouts: [bindings] });
      entry = { descriptor:{ layout, compute: { module, entryPoint: 'main' } }, pipeline:null, promise:null };
      this.pipelines.set(code, entry);
      while (this.pipelines.size > this.pipelineLimit) {
        this.pipelines.delete(this.pipelines.keys().next().value); this.pipelineEvictions++;
      }
    }
    this.pendingPasses.push({entry,inputs,out,groupsX,groupsY});
  }

  async encodePasses() {
    const pipelineStarted = performance.now();
    // Drain a stable snapshot. Batch execution may encode one compute pass at
    // each FIRE boundary; retaining prior descriptors would record every old
    // dispatch again on each boundary (quadratic command growth).
    const pendingPasses=this.pendingPasses.splice(0);
    const entries=[...new Set(pendingPasses.map(pass=>pass.entry))];
    const prepared=await Promise.allSettled(entries.map(entry=>{
      if(entry.pipeline)return entry.pipeline;
      if(!entry.promise)entry.promise=Promise.resolve().then(()=>this.device.createComputePipelineAsync(entry.descriptor)).then(pipeline=>entry.pipeline=pipeline);
      return entry.promise;
    }));
    const failure=prepared.find(result=>result.status==='rejected');
    if(failure){
      for(let i=0;i<prepared.length;i++)if(prepared[i].status==='rejected'){
        for(const [key,entry] of this.pipelines)if(entry===entries[i])this.pipelines.delete(key);
      }
      throw new Error(`WebGPU ${failure.reason?.reason==='validation'?'validation':'pipeline'}: ${failure.reason?.message||failure.reason}`);
    }
    const pipelineCompileMs = performance.now()-pipelineStarted;
    const commandEncodeStarted = performance.now();
    if(pendingPasses.length){
      const useTimestamp=Boolean(this.timestampQuerySet);
      const pass=useTimestamp
        ? this.encoder.beginComputePass({timestampWrites:{querySet:this.timestampQuerySet,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}})
        : this.encoder.beginComputePass();
      this.timestampPassRecorded=useTimestamp;
      this.computePassCount++;
      try{
        for(const {entry,inputs,out,groupsX,groupsY} of pendingPasses){
          const pipeline=entry.pipeline;
          const group=this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[...inputs,out].map((tensor,binding)=>({binding,resource:tensor.bufferOffset!==undefined
            ?{buffer:tensor.buffer,offset:tensor.bufferOffset,size:tensor.bufferSize}
            :{buffer:tensor.buffer}}))});
          pass.setPipeline(pipeline);pass.setBindGroup(0,group);
          pass.dispatchWorkgroups(groupsX,groupsY);
        }
      }finally{pass.end();}
    }
    return {pipeline_compile_ms:pipelineCompileMs,command_encode_ms:performance.now()-commandEncodeStarted};
  }

  track(out, backward) {
    if (out.requiresGrad && this.recording) this.tape.push({ out, backward });
    return out;
  }

  accumulate(target, delta) {
    if (!target.requiresGrad) return;
    if (!target.gradContributions) target.gradContributions = [];
    target.gradContributions.push(delta);
    this.gradientTargets.add(target);
    this.maxGradientFanIn = Math.max(this.maxGradientFanIn, target.gradContributions.length + (target.grad ? 1 : 0));
  }

  materializeGradient(target) {
    const parts = target.gradContributions || [];
    if (!parts.length) return target.grad || null;
    delete target.gradContributions;
    if (target.grad) parts.unshift(target.grad);
    if (parts.length === 1) {
      target.grad = parts[0];
      return target.grad;
    }
    for (const part of parts) this.same(target, part);
    const maxInputs = Math.max(1, this.device.limits.maxStorageBuffersPerShaderStage - 1);
    if (parts.length <= maxInputs) {
      const additions = parts.slice(1).map((_, i) => `value += x${i + 1}[i];`).join('\n');
      target.grad = this.kernel(parts, target.rows, target.cols, `var value = x0[i];\n${additions}\ny[i] = value;`);
      this.gradientMergeKernels++;
      this.gradientMergeInputs += parts.length;
      this.gradientMergeDispatchesSaved += parts.length - 2;
      return target.grad;
    }
    let merged = parts[0];
    for (const part of parts.slice(1)) merged = this.add(merged, part);
    target.grad = merged;
    this.gradientMergeFallbacks++;
    return merged;
  }

  add(a, b) {
    this.same(a, b);
    const out = this.kernel([a, b], a.rows, a.cols, 'y[i] = x0[i] + x1[i];', a.requiresGrad || b.requiresGrad);
    return this.track(out, g => { this.accumulate(a, g); this.accumulate(b, g); });
  }

  mul(a, b) {
    const rows = Math.max(a.rows, b.rows), cols = Math.max(a.cols, b.cols);
    for (const x of [a, b]) if ((x.rows !== rows && x.rows !== 1) || (x.cols !== cols && x.cols !== 1)) throw new Error('invalid GPU broadcast');
    const index = x => `(row % ${Math.max(x.rows, 1)}u) * ${x.cols}u + (col % ${x.cols}u)`;
    const out = this.kernel([a, b], rows, cols, `y[i] = x0[${index(a)}] * x1[${index(b)}];`, a.requiresGrad || b.requiresGrad);
    return this.track(out, g => {
      if (a.requiresGrad) this.accumulate(a, this.reduceTo(this.mul(g, b), a));
      if (b.requiresGrad) this.accumulate(b, this.reduceTo(this.mul(g, a), b));
    });
  }

  gatedProduct(a, b, activationA, activationB) {
    this.same(a, b);
    const activation = (kind, value) => {
      if (kind === 'identity') return { setup: '', value, derivative: '1.0' };
      if (kind === 'silu') {
        const sigmoid = `1.0 / (1.0 + exp(-${value}))`;
        return { setup: `let s_${value} = ${sigmoid};`, value: `${value} * s_${value}`, derivative: `s_${value} * (1.0 + ${value} * (1.0 - s_${value}))` };
      }
      if (kind === 'sigmoid') {
        const sigmoid = `1.0 / (1.0 + exp(-${value}))`;
        return { setup: `let s_${value} = ${sigmoid};`, value: `s_${value}`, derivative: `s_${value} * (1.0 - s_${value})` };
      }
      throw new Error(`unsupported fused activation ${kind}`);
    };
    const left = activation(activationA, 'av'), right = activation(activationB, 'bv');
    const out = this.kernel([a, b], a.rows, a.cols, `
      let av = x0[i]; let bv = x1[i]; ${left.setup} ${right.setup}
      y[i] = (${left.value}) * (${right.value});`, a.requiresGrad || b.requiresGrad);
    return this.track(out, g => {
      if (a.requiresGrad) this.accumulate(a, this.kernel([a, b, g], a.rows, a.cols, `
        let av = x0[i]; let bv = x1[i]; ${left.setup} ${right.setup}
        y[i] = x2[i] * (${left.derivative}) * (${right.value});`));
      if (b.requiresGrad) this.accumulate(b, this.kernel([a, b, g], b.rows, b.cols, `
        let av = x0[i]; let bv = x1[i]; ${left.setup} ${right.setup}
        y[i] = x2[i] * (${left.value}) * (${right.derivative});`));
    });
  }

  reduceTo(x, target) {
    if (x.rows === target.rows && x.cols === target.cols) return x;
    return this.kernel([x], target.rows, target.cols, `
      var value = 0.0;
      for (var r = row; r < ${x.rows}u; r += ${Math.max(target.rows, 1)}u) {
        for (var c = col; c < ${x.cols}u; c += ${target.cols}u) { value += x0[r * ${x.cols}u + c]; }
      } y[i] = value;`);
  }

  activation(x, kind) {
    const out = this.kernel([x], x.rows, x.cols, kind === 'silu'
      ? 'y[i] = x0[i] / (1.0 + exp(-x0[i]));' : 'y[i] = 1.0 / (1.0 + exp(-x0[i]));', x.requiresGrad);
    return this.track(out, g => {
      const delta = this.kernel([x, out, g], x.rows, x.cols, kind === 'silu'
        ? 'let s = 1.0 / (1.0 + exp(-x0[i])); y[i] = x2[i] * (s + x1[i] * (1.0 - s));'
        : 'y[i] = x2[i] * x1[i] * (1.0 - x1[i]);');
      this.accumulate(x, delta);
    });
  }

  linear(x, weight, bias = null) {
    if (x.cols !== weight.cols) throw new Error('GPU linear shape mismatch');
    const inputs = bias ? [x, weight, bias] : [x, weight];
    const out = x.cols >= 16 && weight.rows >= 16
      ? this.tiledProduct(x,weight,bias,true,x.requiresGrad)
      : this.kernel(inputs, x.rows, weight.rows, `
      var value = 0.0;
      for (var k = 0u; k < ${x.cols}u; k++) { value += x0[row * ${x.cols}u + k] * x1[col * ${x.cols}u + k]; }
      y[i] = value${bias ? ' + x2[col]' : ''};`, x.requiresGrad);
    return this.track(out, g => {
      const delta = x.cols >= 16 && weight.rows >= 16
        ? this.tiledProduct(g,weight,null,false,false)
        : this.kernel([g, weight], x.rows, x.cols, `
        var value = 0.0;
        for (var k = 0u; k < ${weight.rows}u; k++) { value += x0[row * ${weight.rows}u + k] * x1[k * ${x.cols}u + col]; }
        y[i] = value;`);
      this.accumulate(x, delta);
    });
  }

  tiledProduct(a, weight, bias, transposeWeight, requiresGrad) {
    const rows=a.rows, inner=a.cols, cols=transposeWeight?weight.rows:weight.cols;
    const inputs=bias?[a,weight,bias]:[a,weight];
    const out=this.tensor(null,rows,cols,requiresGrad);
    if(!out.size)return out;
    const declarations=inputs.map((x,i)=>`@group(0) @binding(${i}) var<storage,read> x${i}:array<f32>;`).join('\n');
    const weightIndex=transposeWeight?`c * ${inner}u + bk`:`bk * ${cols}u + c`;
    const code=`${declarations}
@group(0) @binding(${inputs.length}) var<storage,read_write> y:array<f32>;
var<workgroup> block_a:array<f32,256>;
var<workgroup> block_b:array<f32,256>;
@compute @workgroup_size(16,16) fn main(@builtin(global_invocation_id) id:vec3<u32>, @builtin(local_invocation_id) local:vec3<u32>){
  let r=id.y;let c=id.x;let slot=local.y*16u+local.x;
  var total=0.0;
  for(var base=0u;base<${inner}u;base+=16u){
    let ak=base+local.x;let bk=base+local.y;
    block_a[slot]=0.0;block_b[slot]=0.0;
    if(r<${rows}u && ak<${inner}u){block_a[slot]=x0[r*${inner}u+ak];}
    if(c<${cols}u && bk<${inner}u){block_b[slot]=x1[${weightIndex}];}
    workgroupBarrier();
    for(var k=0u;k<16u;k++){total+=block_a[local.y*16u+k]*block_b[k*16u+local.x];}
    workgroupBarrier();
  }
  if(r<${rows}u && c<${cols}u){y[r*${cols}u+c]=total${bias?'+x2[c]':''};}
}`;
    this.dispatch(inputs,out,code,Math.ceil(cols/16),Math.ceil(rows/16));
    return out;
  }

  indices(values, count) {
    if (values.some(v => !Number.isInteger(v) || v < 0 || v >= count)) throw new Error('GPU index outside tensor');
    const tensor = this.tensor(values, values.length, 1, false, false, 'u32');
    tensor.values = values; tensor.csr = new Map();
    return tensor;
  }

  gather(x, index) {
    const out = this.kernel([x, index], index.rows, x.cols, `y[i] = x0[x1[row] * ${x.cols}u + col];`, x.requiresGrad);
    return this.track(out, g => this.accumulate(x, this.scatter(g, index, x.rows)));
  }

  scatter(x, index, count) {
    let csr = index.csr.get(count);
    if (!csr) {
      const ptr = new Uint32Array(count + 1), order = new Uint32Array(index.values.length);
      for (const row of index.values) ptr[row + 1]++;
      for (let i = 0; i < count; i++) ptr[i + 1] += ptr[i];
      const cursor = ptr.slice();
      index.values.forEach((row, i) => { order[cursor[row]++] = i; });
      csr = [this.tensor(ptr, ptr.length, 1, false, false, 'u32'), this.tensor(order, order.length, 1, false, false, 'u32')];
      index.csr.set(count, csr);
    }
    const out = this.kernel([x, ...csr], count, x.cols, `
      var value = 0.0;
      for (var j = x1[row]; j < x1[row + 1u]; j++) { value += x0[x2[j] * ${x.cols}u + col]; }
      y[i] = value;`, x.requiresGrad);
    return this.track(out, g => this.accumulate(x, this.gather(g, index)));
  }

  cat(a, b, c) {
    if (a.rows !== b.rows || a.rows !== c.rows) throw new Error('GPU concat shape mismatch');
    const cols = a.cols + b.cols + c.cols;
    const out = this.kernel([a, b, c], a.rows, cols, `
      if (col < ${a.cols}u) { y[i] = x0[row * ${a.cols}u + col]; }
      else if (col < ${a.cols+b.cols}u) { y[i] = x1[row * ${b.cols}u + col - ${a.cols}u]; }
      else { y[i] = x2[row * ${c.cols}u + col - ${a.cols+b.cols}u]; }`, a.requiresGrad || b.requiresGrad || c.requiresGrad);
    return this.track(out, g => {
      let offset = 0;
      for (const x of [a, b, c]) {
        if (x.requiresGrad) this.accumulate(x, this.kernel([g], x.rows, x.cols, `y[i] = x0[row * ${cols}u + col + ${offset}u];`));
        offset += x.cols;
      }
    });
  }

  sum(x) {
    const out = this.kernel([x], 1, 1, `var value = 0.0; for (var j = 0u; j < ${x.size}u; j++) { value += x0[j]; } y[0] = value;`, x.requiresGrad);
    return this.track(out, g => this.accumulate(x, this.kernel([g], x.rows, x.cols, 'y[i] = x0[0];')));
  }

  scaledEnergySum(atomic, scale, shift) {
    this.same(atomic, scale); this.same(atomic, shift);
    const out = this.kernel([atomic, scale, shift], 1, 1, `
      var value = 0.0;
      for (var j = 0u; j < ${atomic.size}u; j++) { value += x0[j] * x1[j] + x2[j]; }
      y[0] = value;`, atomic.requiresGrad);
    return this.track(out, g => {
      if (atomic.requiresGrad) this.accumulate(atomic, this.kernel([g, scale], atomic.rows, atomic.cols, 'y[i] = x0[0] * x1[i];'));
    });
  }

  backward(output) {
    this.recording = false;
    output.grad = this.tensor([1], 1, 1);
    for (let i = this.tape.length - 1; i >= 0; i--) {
      const { out, backward } = this.tape[i];
      const gradient = this.materializeGradient(out);
      if (gradient) backward(gradient);
    }
    for (const target of this.gradientTargets) this.materializeGradient(target);
  }

  async finish(tensors) {
    let readback, readbackMapped = false, completed = false;
    const finishStarted = performance.now();
    try {
      const encodeTiming = await this.encodePasses();
      const readbackSetupStarted = performance.now();
      const total = tensors.reduce((sum, x) => sum + x.size, 0);
      const queryOffset=this.timestampPassRecorded?Math.ceil(total*4/256)*256:0;
      const readbackBytes=this.timestampPassRecorded?queryOffset+16:Math.max(4,total*4);
      let createdReadback = false;
      if (!this.readbackBuffer || readbackBytes > this.readbackCapacityBytes) {
        const replacingReadback = this.readbackBuffer !== null;
        const capacity = Math.ceil(readbackBytes/256)*256;
        this.assertRequestedBufferBudget(capacity, replacingReadback ? this.readbackCapacityBytes : 0);
        if (replacingReadback && this.requestedBufferLimitBytes !== null) {
          this.readbackBuffer.destroy(); this.readbackBuffer = null; this.readbackCapacityBytes = 0;
        }
        const replacement = this.device.createBuffer({ size: capacity, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        if (replacingReadback && this.requestedBufferLimitBytes === null) this.readbackBuffer?.destroy();
        this.readbackBuffer = replacement;
        this.readbackCapacityBytes = capacity;
        this.readbackBufferCreates++;
        if (replacingReadback) this.readbackBufferGrows++;
        createdReadback = true;
      }
      if (!createdReadback) this.readbackBufferReuses++;
      readback = this.readbackBuffer;
      this.peakBufferBytes = Math.max(this.peakBufferBytes,this.modelBytes+this.transientBytes+this.poolBytes+this.readbackCapacityBytes);
      let offset = 0;
      for (const x of tensors) { if (x.size) this.encoder.copyBufferToBuffer(x.buffer, x.bufferOffset??0, readback, offset * 4, x.size * 4); offset += x.size; }
      if(this.timestampPassRecorded){
        this.encoder.resolveQuerySet(this.timestampQuerySet,0,2,this.timestampResolveBuffer,0);
        this.encoder.copyBufferToBuffer(this.timestampResolveBuffer,0,readback,queryOffset,16);
      }
      const readbackSetupMs = performance.now()-readbackSetupStarted;
      this.device.queue.submit([this.encoder.finish()]); this.encoder = null;
      this.submittedCommandBuffers++;
      const submittedAt = performance.now();
      await readback.mapAsync(GPUMapMode.READ);
      readbackMapped = true;
      const submitToMapMs = performance.now()-submittedAt;
      const mappedCopyStarted = performance.now();
      const data = total?new Float32Array(readback.getMappedRange(0,total*4)).slice():new Float32Array();
      const mappedCopyMs = performance.now()-mappedCopyStarted;
      const gpuTimestamps=this.timestampPassRecorded?new BigUint64Array(readback.getMappedRange(queryOffset,16)).slice():null;
      const gpuTimestampMs=gpuTimestamps?Number(gpuTimestamps[1]-gpuTimestamps[0])/1e6:null;
      readback.unmap(); readbackMapped = false;
      const errorScopeStarted = performance.now();
      const error = await this.closeScope();
      const errorScopeMs = performance.now()-errorScopeStarted;
      if (error) throw new Error(`WebGPU validation: ${error.message}`);
      if (!data.every(Number.isFinite)) throw new Error('WebGPU returned NaN/Infinity');
      this.lastFinishTiming = {
        pipeline_compile_ms:encodeTiming.pipeline_compile_ms,
        command_encode_ms:encodeTiming.command_encode_ms,
        readback_setup_ms:readbackSetupMs,
        submit_to_map_ms:submitToMapMs,
        gpu_timestamp_ms:gpuTimestampMs,
        mapped_copy_ms:mappedCopyMs,
        error_scope_ms:errorScopeMs,
        submitted_command_buffers:this.submittedCommandBuffers,
        readback_capacity_bytes:this.readbackCapacityBytes,
        readback_buffer_created:createdReadback,
        total_ms:performance.now()-finishStarted,
      };
      completed = true;
      offset = 0;
      return tensors.map(x => { const result = data.slice(offset, offset+x.size); offset += x.size; return result; });
    } finally {
      try { await this.closeScope(); } catch {}
      if (readbackMapped) { try { readback.unmap(); } catch {} }
      if (!completed && this.submittedCommandBuffers && !this.lost) {
        try { await this.device.queue.onSubmittedWorkDone?.(); } catch {}
      }
      if (!completed && readback && this.readbackBuffer === readback) {
        readback.destroy();
        this.readbackBuffer = null;
        this.readbackCapacityBytes = 0;
      }
      this.releaseEvaluation(completed);
    }
  }

  releaseTimestampResources() {
    this.timestampQuerySet?.destroy();this.timestampResolveBuffer?.destroy();
    this.timestampQuerySet=null;this.timestampResolveBuffer=null;
  }

  async closeScope() {
    if (!this.scopeOpen) return null;
    this.scopeOpen = false;
    return this.device.popErrorScope();
  }

  releaseEvaluation(completed) {
    for (const buffer of this.transient) {
      const size = this.bufferSizes.get(buffer);
      if (completed && size && this.poolBytes+size <= this.poolLimitBytes) {
        if (!this.pool.has(size)) this.pool.set(size,[]);
        this.pool.get(size).push(buffer); this.poolBytes += size;
      } else { buffer.destroy(); this.bufferSizes.delete(buffer); }
    }
    this.encoder = null; this.evaluationActive = false; this.submittedCommandBuffers = 0;
    this.transient.clear(); this.tape = []; this.pendingPasses = []; this.recording = true; this.gradientTargets.clear();
    this.transientBytes = 0;
    this.requestedBufferLimitBytes = null;
    this.timestampPassRecorded = false;
    this.lastMemory = {
      model_buffer_bytes:this.modelBytes,requested_buffer_peak_bytes:this.peakBufferBytes,
      readback_buffer_capacity_bytes:this.readbackCapacityBytes,
      readback_buffer_creates:this.readbackBufferCreates,readback_buffer_reuses:this.readbackBufferReuses,
      readback_buffer_grows:this.readbackBufferGrows,
      pooled_bytes_after:this.poolBytes,pool_limit_bytes:this.poolLimitBytes,
      allocated_buffers:this.allocatedBuffers-this.allocationStart,reused_buffers:this.reusedBuffers-this.reuseStart,
      active_transient_buffers_after:this.transient.size,pipeline_count:this.pipelines.size,
      pipeline_limit:this.pipelineLimit,pipeline_evictions:this.pipelineEvictions,
      dispatch_count:this.dispatchCount,compute_pass_count:this.computePassCount,
      gradient_merge_kernels:this.gradientMergeKernels,gradient_merge_inputs:this.gradientMergeInputs,
      gradient_merge_dispatches_saved:this.gradientMergeDispatchesSaved,gradient_merge_fallbacks:this.gradientMergeFallbacks,
      max_gradient_fan_in:this.maxGradientFanIn,
      scope:'WebGPU requested buffer byte accounting; not physical VRAM or full page memory',
    };
  }

  async submitBatchStep(excludedBuffers) {
    if(!this.evaluationActive||!this.encoder)throw new Error('batch intermediate recycling requires an active GPU evaluation');
    // Submit this boundary before intermediate buffers can be checked out by
    // a later FIRE update. Reuse inside one unsubmitted command buffer aliases
    // distinct values and can stall or corrupt GPU readback.
    await this.encodePasses();
    if(this.pendingPasses.length)throw new Error('batch boundary left unencoded compute passes');
    const keep=new Set(excludedBuffers);
    this.device.queue.submit([this.encoder.finish()]);
    this.submittedCommandBuffers++;
    this.encoder=this.device.createCommandEncoder();
    this.tape=[];this.gradientTargets.clear();
    for(const buffer of [...this.transient]){
      if(keep.has(buffer))continue;
      const size=this.bufferSizes.get(buffer);
      if(!size)throw new Error('batch intermediate buffer has no tracked size');
      // Queue submissions are ordered. A future encoder can reuse this buffer
      // because its commands are submitted after this segment on the same queue.
      if(this.poolBytes+size>this.poolLimitBytes)continue;
      this.transient.delete(buffer);this.transientBytes-=size;
      if(!this.pool.has(size))this.pool.set(size,[]);
      this.pool.get(size).push(buffer);this.poolBytes+=size;
    }
  }

  async abort() {
    if(this.submittedCommandBuffers&&!this.lost){
      try{await this.device.queue.onSubmittedWorkDone?.();}catch{}
    }
    try { await this.closeScope(); } catch {}
    finally { this.releaseEvaluation(false); }
  }

  same(a, b) { if (a.rows !== b.rows || a.cols !== b.cols) throw new Error('GPU tensor shapes differ'); }
  destroy() {
    this.lost = 'device destroyed';
    for (const b of this.bufferSizes.keys()) b.destroy();
    this.readbackBuffer?.destroy();this.readbackBuffer=null;this.readbackCapacityBytes=0;
    this.bufferSizes.clear();this.persistent.clear();this.transient.clear();this.pool.clear();this.poolBytes=0;
    this.pipelines.clear();this.releaseTimestampResources();this.device.destroy();
  }
}
