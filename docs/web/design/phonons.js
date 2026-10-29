/* Local phonopy band.yaml reader and first-import mode viewer. */
(function (root) {
  'use strict';

  const fail = message => { throw new Error(message); };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const vector = (value, name) => {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(finite)) fail(`${name} must contain three finite numbers.`);
    return value.slice();
  };
  const matrix3 = (value, name) => {
    if (!Array.isArray(value) || value.length !== 3) fail(`${name} must have three rows.`);
    return value.map((row, i) => vector(row, `${name} row ${i + 1}`));
  };
  const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const distanceToAngstrom = calculator => {
    const mode = String(calculator || '').toLowerCase();
    return ['abinit', 'qe', 'pwscf', 'wien2k', 'elk', 'siesta', 'dftbp', 'cp2k'].includes(mode) ? 0.529177210903 : 1;
  };

  function parseBandYaml(text, options = {}) {
    const maxBytes = options.maxBytes || 25 * 1024 * 1024;
    if (typeof text !== 'string' || !text.trim()) fail('The selected band.yaml file is empty.');
    if (new TextEncoder().encode(text).byteLength > maxBytes) fail(`The file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MiB import limit.`);
    if (!root.jsyaml || typeof root.jsyaml.load !== 'function') fail('The local YAML reader did not load. Reload this app package and try again.');
    let raw;
    try { raw = root.jsyaml.load(text, {schema: root.jsyaml.JSON_SCHEMA, maxAliasCount: 0}); }
    catch (error) { fail(`Could not read band.yaml: ${error.message || 'invalid YAML'}`); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('The YAML root must be a mapping.');

    const conversion = distanceToAngstrom(raw.calculator);
    const lattice = matrix3(raw.lattice, 'lattice').map(row => row.map(value => value * conversion));
    if (Math.abs(dot(lattice[0], cross(lattice[1], lattice[2]))) < 1e-12) fail('The band.yaml lattice is singular.');
    const atoms = Array.isArray(raw.points) ? raw.points : raw.atoms;
    if (!Array.isArray(atoms) || atoms.length < 1 || atoms.length > 500) fail('The file must contain 1–500 primitive-cell atoms.');
    const parsedAtoms = atoms.map((atom, index) => {
      const symbol = atom?.symbol;
      if (typeof symbol !== 'string' || !/^[A-Z][a-z]?$/.test(symbol)) fail(`Atom ${index + 1} has an invalid element symbol.`);
      const fractional = vector(atom.coordinates || atom.position, `atom ${index + 1} coordinates`);
      const mass = atom.mass === undefined ? null : atom.mass;
      if (mass !== null && (!finite(mass) || mass <= 0)) fail(`Atom ${index + 1} has an invalid mass.`);
      return {element: symbol, fractional, mass};
    });
    if (raw.natom !== undefined && raw.natom !== parsedAtoms.length) fail('natom does not match points.atoms.');
    const nqpoint = raw.nqpoint;
    if (!Number.isInteger(nqpoint) || nqpoint < 1 || nqpoint > 50000) fail('nqpoint must be an integer from 1 to 50,000.');
    const npath = raw.npath;
    if (!Number.isInteger(npath) || npath < 1 || npath > nqpoint) fail('npath must be a valid positive segment count.');
    const counts = raw.segment_nqpoint;
    if (!Array.isArray(counts) || counts.length !== npath || counts.some(n => !Number.isInteger(n) || n < 1) || counts.reduce((a, b) => a + b, 0) !== nqpoint) fail('segment_nqpoint must match npath and sum to nqpoint.');
    const phonon = raw.phonon;
    if (!Array.isArray(phonon) || phonon.length !== nqpoint) fail('phonon must contain exactly nqpoint entries.');
    const nmodes = parsedAtoms.length * 3;
    let eigenvectors = null;
    let vectorCount = 0;
    const qpoints = phonon.map((point, qi) => {
      const q = vector(point?.['q-position'], `q-point ${qi + 1}`);
      const distance = point?.distance;
      if (!finite(distance) || distance < 0) fail(`q-point ${qi + 1} has an invalid path distance.`);
      if (!Array.isArray(point.band) || point.band.length !== nmodes) fail(`q-point ${qi + 1} must contain ${nmodes} branches.`);
      const bands = point.band.map((band, mi) => {
        if (!finite(band?.frequency)) fail(`q-point ${qi + 1}, mode ${mi + 1} has an invalid frequency.`);
        const hasVector = band.eigenvector !== undefined;
        if (hasVector) {
          vectorCount++;
          if (!Array.isArray(band.eigenvector) || band.eigenvector.length !== parsedAtoms.length) fail(`q-point ${qi + 1}, mode ${mi + 1} has an invalid eigenvector atom count.`);
          for (let ai = 0; ai < band.eigenvector.length; ai++) {
            const axes = band.eigenvector[ai];
            if (!Array.isArray(axes) || axes.length !== 3 || axes.some(pair => !Array.isArray(pair) || pair.length !== 2 || !pair.every(finite))) fail(`q-point ${qi + 1}, mode ${mi + 1}, atom ${ai + 1} has an invalid complex eigenvector.`);
          }
        }
        return {frequencyTHz: band.frequency, eigenvector: hasVector ? band.eigenvector.map(atom => atom.map(pair => pair.slice())) : null};
      });
      return {q, distance, label: typeof point.label === 'string' ? point.label : '', bands};
    });
    const hasEigenvectors = vectorCount === nqpoint * nmodes;
    if (vectorCount !== 0 && !hasEigenvectors) fail('Eigenvectors are only present for part of the band data. Import a complete band.yaml or remove the partial eigenvectors.');
    if (raw.labels !== undefined && (!Array.isArray(raw.labels) || raw.labels.length !== npath || raw.labels.some(row => !Array.isArray(row) || row.length !== 2))) fail('labels must contain two endpoint labels for each path segment.');
    const segments = [];
    let first = 0;
    for (let i = 0; i < counts.length; i++) {
      const last = first + counts[i] - 1;
      segments.push({start: first, end: last, labels: raw.labels?.[i] || null});
      first = last + 1;
    }
    return {lattice, atoms: parsedAtoms, qpoints, segments, hasEigenvectors, calculator: raw.calculator || null, units: 'THz'};
  }

  const cartesian = (fractional, cell) => [0, 1, 2].map(axis => fractional[0] * cell[0][axis] + fractional[1] * cell[1][axis] + fractional[2] * cell[2][axis]);
  function modeDisplacement(eigenvector, q, fractional, phase = 0, amplitude = 1) {
    if (!Array.isArray(eigenvector) || eigenvector.length !== 3 || eigenvector.some(pair => !Array.isArray(pair) || pair.length !== 2 || !pair.every(finite)) || !Array.isArray(q) || q.length !== 3 || !q.every(finite) || !Array.isArray(fractional) || fractional.length !== 3 || !fractional.every(finite) || !finite(phase) || !finite(amplitude)) fail('A mode displacement needs finite eigenvector, q-point, coordinate, phase, and amplitude values.');
    const theta = 2 * Math.PI * (q[0] * fractional[0] + q[1] * fractional[1] + q[2] * fractional[2]) + phase;
    return eigenvector.map(pair => amplitude * (pair[0] * Math.cos(theta) - pair[1] * Math.sin(theta)));
  }

  // Original phononwebsite defaults: blue 2px branches, 20px path labels,
  // solid symmetry separators/zero line, red selected point, cm^-1 frequency.
  // Keep result data and viewport coordinates in THz; convert display only.
  const WAVENUMBER_PER_THZ = 1e12 / (299792458 * 100);
  function niceFrequencyStep(span, count) {
    const raw=Math.max(span,1e-12)/Math.max(2,count), power=10**Math.floor(Math.log10(raw)), fraction=raw/power;
    return ([1,2,2.5,5,10].find(value=>value>=fraction)||10)*power;
  }
  const modeWeightCache=new WeakMap();
  function modeWeights(data){
    if(modeWeightCache.has(data))return modeWeightCache.get(data);
    const elements=[...new Set(data.atoms.map(atom=>atom.element))],indices=data.atoms.map(atom=>elements.indexOf(atom.element));
    const weights=data.qpoints.map(q=>q.bands.map(band=>{const totals=elements.map(()=>0);let total=0;band.eigenvector.forEach((axes,i)=>{// phononwebsite PhononYaml mass-normalizes vec before computing weights;
      // its common average-mass factor cancels when normalizing each mode.
      const weight=axes.reduce((sum,pair)=>sum+pair[0]**2+pair[1]**2,0)/(data.atoms[i].mass||1);totals[indices[i]]+=weight;total+=weight;});return totals.map(value=>total>0?value/total:0);}));
    const result={elements,weights};modeWeightCache.set(data,result);return result;
  }
  function drawBands(canvas, data, selectedQ, selectedMode, viewport = null) {
    const rect=canvas.getBoundingClientRect(),dpr=Math.max(1,root.devicePixelRatio||1);
    const width=Math.max(1,Math.round(rect.width*dpr)),height=Math.max(1,Math.round(rect.height*dpr));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    const ctx=canvas.getContext('2d');if(!ctx)return null;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    const w=rect.width,h=rect.height,pad={l:66,r:22,t:16,b:42},plotW=Math.max(1,w-pad.l-pad.r),initialPlotH=Math.max(1,h-pad.t-pad.b);
    let plotH=initialPlotH;
    const unit=viewport?.unit||'cm-1',factor=unit==='THz'?1:WAVENUMBER_PER_THZ,label=unit==='THz'?'THz':'cm⁻¹';
    let minimum=0,maximum=0;for(const point of data.qpoints)for(const band of point.bands){minimum=Math.min(minimum,band.frequencyTHz);maximum=Math.max(maximum,band.frequencyTHz);}
    if(maximum-minimum<1e-12){minimum-=1;maximum+=1;}
    const autoStep=niceFrequencyStep((maximum-minimum)*factor,plotH/72);
    let lo=viewport?.lo??Math.floor(minimum*factor/autoStep)*autoStep/factor,hi=viewport?.hi??Math.ceil(maximum*factor/autoStep)*autoStep/factor;
    const step=niceFrequencyStep((hi-lo)*factor,plotH/72),maxD=data.qpoints.at(-1).distance||1;
    const xlo=viewport?.xlo??0,xhi=viewport?.xhi??maxD;
    const x=i=>pad.l+(data.qpoints[i].distance-xlo)/(xhi-xlo)*plotW,y=f=>pad.t+(hi-f)/(hi-lo)*plotH;
    ctx.clearRect(0,0,w,h);ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
    ctx.font='12px Arial, sans-serif';ctx.textAlign='right';
    for(let value=Math.ceil((lo*factor-1e-9)/step)*step;value<=hi*factor+step*1e-8;value+=step){
      const yy=y(value/factor);ctx.strokeStyle='#e6e6e6';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(w-pad.r,yy);ctx.stroke();ctx.fillStyle='#333';
      const power=Math.floor(Math.log10(step)),decimals=Math.max(0,-power+(Math.abs(step/10**power-2.5)<1e-8?1:0));
      const text=step<.001?value.toExponential(2):Number(value.toFixed(decimals)).toString();ctx.fillText(text,pad.l-9,yy+4);
    }
    const tickSegments=viewport?.segment&&viewport.segment!=='all'?[data.segments[Number(viewport.segment)]]:data.segments;
    const ticks=new Map();for(const segment of tickSegments){if(!segment?.labels)continue;for(const [index,label] of [[segment.start,segment.labels[0]],[segment.end,segment.labels[1]]]){const key=x(index).toFixed(3),tick=ticks.get(key)||{x:x(index),labels:[]};if(!tick.labels.includes(String(label)))tick.labels.push(String(label));ticks.set(key,tick);}}
    const labelRows=[],labelLayout=[];ctx.font='13px Arial, sans-serif';
    for(const tick of [...ticks.values()].sort((a,b)=>a.x-b.x)){
      if(tick.x<pad.l-1||tick.x>w-pad.r+1)continue;
      const text=tick.labels.join(' | '),width=ctx.measureText(text).width;
      const cx=Math.max(pad.l+width/2,Math.min(w-pad.r-width/2,tick.x)),left=cx-width/2;
      let row=labelRows.findIndex(right=>left>=right+10);if(row<0)row=labelRows.length;
      labelRows[row]=cx+width/2;labelLayout.push({text,x:cx,row,tickX:tick.x});
    }
    pad.b=28+Math.max(1,labelRows.length)*19;plotH=Math.max(80,h-pad.t-pad.b);
    if(lo<=0&&hi>=0){ctx.strokeStyle='#000';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(pad.l,y(0));ctx.lineTo(w-pad.r,y(0));ctx.stroke();}
    ctx.save();ctx.beginPath();ctx.rect(pad.l,pad.t,plotW,plotH);ctx.clip();
    const starts=new Set(data.segments.map(segment=>segment.start));
    ctx.lineCap='round';ctx.lineJoin='round';
    const weighted=!!viewport?.modeWeights&&data.hasEigenvectors;
    if(weighted){
      const cache=modeWeights(data),visible=cache.elements.map((element,i)=>({element,i})).filter(({element})=>!viewport.hiddenElements?.includes(element));
      for(let mode=0;mode<data.qpoints[0].bands.length;mode++)for(let qi=0;qi<data.qpoints.length-1;qi++){
        if(starts.has(qi+1)||!visible.length||x(qi+1)<pad.l||x(qi)>w-pad.r)continue;
        const avg=cache.weights[qi][mode].map((value,i)=>(value+cache.weights[qi+1][mode][i])/2);
        let total=0,rgb=[0,0,0];for(const {element,i} of visible){const color=parseInt((viewport.elementColors?.[element]||'#0066ff').slice(1),16),weight=avg[i];rgb[0]+=((color>>16)&255)*weight;rgb[1]+=((color>>8)&255)*weight;rgb[2]+=(color&255)*weight;total+=weight;}
        ctx.strokeStyle=total>0?'rgb('+rgb.map(value=>Math.round(value/total)).join(',')+')':viewport.elementColors?.[visible[0].element]||'#0066ff';
        ctx.lineWidth=visible.length===1?1.5+8*avg[visible[0].i]:9.5;
        ctx.beginPath();ctx.moveTo(x(qi),y(data.qpoints[qi].bands[mode].frequencyTHz));ctx.lineTo(x(qi+1),y(data.qpoints[qi+1].bands[mode].frequencyTHz));ctx.stroke();
      }
    }
    ctx.strokeStyle=weighted?'#94a3b8':'#0066ff';ctx.lineWidth=weighted?.7:1.25;
    for(let mode=0;mode<data.qpoints[0].bands.length;mode++){
      ctx.beginPath();data.qpoints.forEach((point,qi)=>{const px=x(qi),py=y(point.bands[mode].frequencyTHz);starts.has(qi)||qi===0?ctx.moveTo(px,py):ctx.lineTo(px,py);});ctx.stroke();
    }
    // Match the upstream solid high-symmetry lines (including both endpoints).
    for(const tick of ticks.values()){ctx.strokeStyle='#555';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(tick.x,pad.t);ctx.lineTo(tick.x,h-pad.b);ctx.stroke();}
    ctx.restore();
    ctx.save();ctx.beginPath();ctx.rect(pad.l,pad.t,plotW,plotH);ctx.clip();ctx.strokeStyle='#c53c2f';ctx.lineWidth=2.2;ctx.beginPath();
    data.qpoints.forEach((point,qi)=>{const px=x(qi),py=y(point.bands[selectedMode].frequencyTHz);starts.has(qi)||qi===0?ctx.moveTo(px,py):ctx.lineTo(px,py);});ctx.stroke();ctx.restore();
    const px=x(selectedQ),py=y(data.qpoints[selectedQ].bands[selectedMode].frequencyTHz);
    if(px>=pad.l-.01&&px<=w-pad.r+.01&&py>=pad.t&&py<=h-pad.b){ctx.fillStyle='#f00';ctx.beginPath();ctx.arc(px,py,5,0,Math.PI*2);ctx.fill();}
    ctx.fillStyle='#333';ctx.font='13px Arial, sans-serif';ctx.textAlign='center';
    for(const item of labelLayout){const yy=h-pad.b+22+item.row*19;ctx.fillText(item.text,item.x,yy);if(item.row>0){ctx.strokeStyle='#aab1ba';ctx.lineWidth=.6;ctx.beginPath();ctx.moveTo(item.tickX,h-pad.b+3);ctx.lineTo(item.x,yy-12);ctx.stroke();}}
    ctx.save();ctx.translate(17,h/2);ctx.rotate(-Math.PI/2);ctx.font='12px Arial, sans-serif';ctx.textAlign='center';ctx.fillText('Frequency ('+label+')',0,0);ctx.restore();
    // Draw the same legend in the canvas so exported PNGs retain element labels.
    // The HTML legend overlays it to provide focusable, clickable toggles.
    if(weighted){const elements=modeWeights(data).elements;ctx.font='12px Arial,sans-serif';ctx.textAlign='left';const sizes=elements.map(element=>ctx.measureText(element).width+43),total=sizes.reduce((a,b)=>a+b,0);let left=pad.l+(plotW-total)/2;ctx.fillStyle='rgba(255,255,255,.85)';ctx.fillRect(left-5,8,total+10,24);elements.forEach((element,i)=>{ctx.globalAlpha=viewport.hiddenElements?.includes(element)?.35:1;ctx.fillStyle=viewport.elementColors?.[element]||'#0066ff';ctx.fillRect(left+5,17,18,7);ctx.fillStyle='#333';ctx.fillText(element,left+29,25);left+=sizes[i];});ctx.globalAlpha=1;}
    return {x,y,pad,labelLayout,width:w,height:h,xlo,xhi,lo,hi,distanceAt:px=>xlo+(px-pad.l)/plotW*(xhi-xlo),frequencyAt:py=>hi-(py-pad.t)/plotH*(hi-lo)};
  }

  function visualizationFrame(data,{qIndex=0,modeIndex=0,repeats=[2,2,2],phase=0,amplitude=.2,equilibrium=false}={}) {
      const qpoint = data.qpoints[qIndex], band = qpoint.bands[modeIndex];
      const cell = data.lattice.map((row, i) => row.map(value => value * repeats[i]));
      const atoms = [], equilibriumPositions = [];
      const meanMass=data.atoms.reduce((sum,atom)=>sum+(atom.mass||1),0)/data.atoms.length;
      for (let a = 0; a < repeats[0]; a++) for (let b = 0; b < repeats[1]; b++) for (let c = 0; c < repeats[2]; c++) {
        const translation = [a, b, c];
        data.atoms.forEach((atom, atomIndex) => {
          const frac = atom.fractional.map((v, i) => v + translation[i]);
          const position = cartesian(frac, data.lattice);
          equilibriumPositions.push(position.slice());
          if (data.hasEigenvectors && !equilibrium) {
            const eigen = band.eigenvector[atomIndex];
            const scaled = eigen.map(pair => pair.map(x => x * Math.sqrt(meanMass / (atom.mass || 1))));
            const displacement = modeDisplacement(scaled, qpoint.q, frac, phase, amplitude);
            for (let axis = 0; axis < 3; axis++) position[axis] += displacement[axis];
          }
          atoms.push({element: atom.element, position, mask: [true, true, true]});
        });
      }
      // A fixed finite set of periodic images, just like phononwebsite: never
      // wrap moving atoms or regenerate boundary images during a vibration.
      return {atoms, cell, pbc: [true, true, true], displayUnwrapped: true, displayCell:data.lattice.map(row=>row.slice()), equilibriumPositions, motionAmplitude:amplitude, format: 'phonopy-band-yaml'};
  }

  function initPhononTab() {
    const $ = id => root.document.getElementById(id);
    const relaxTab = $('relax-tab'), phononTab = $('phonon-tab');
    const showTab = phonons => {
      $('relax-workspace').closest('.app')?.setAttribute('data-active-workspace', phonons ? 'phonons' : 'relax');
      $('relax-workspace').hidden = phonons;
      $('phonon-workspace').hidden = !phonons;
      relaxTab.classList.toggle('active', !phonons); relaxTab.setAttribute('aria-pressed', String(!phonons));
      phononTab.classList.toggle('active', phonons); phononTab.setAttribute('aria-pressed', String(phonons));
      if (phonons) root.requestAnimationFrame(() => { root.PhononBand._redraw?.(); root.PhononJob?.redraw?.(); });
    };
    relaxTab?.addEventListener('click', () => showTab(false));
    phononTab?.addEventListener('click', () => showTab(true));
    const upload = $('phonon-file'), status = $('phonon-status'), canvas = $('phonon-band-plot');
    if (!upload || !canvas || !root.CrystalViewer) return;
    let data = null, qIndex = 0, modeIndex = 0, viewer = null, animation = 0, playing = false, phase = 0, equilibrium = false, previousTime = null;
    let structureAnalysisGeneration = 0, viewport=null, plotDrag=null;
    let appearance={},hiddenWeightElements=new Set(),scaleDefaults=null,nearestNeighbor=null;
    function elementColor(element){const rgb=$('phonon-display-model').value==='vesta'?root.PhononwebsiteVestaStyle?.colorLinear(element):null;return appearance[element]?.color||(rgb?'#'+rgb.map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join(''):root.ElementStyles[element]?.color)||'#808080';}
    const redraw=()=>{if(!data)return null;const enabled=$('phonon-mode-weights').checked&&data.hasEigenvectors;$('phonon-weight-legend').hidden=!enabled;for(const button of $('phonon-weight-legend').children){button.style.setProperty('--element-color',elementColor(button.dataset.element));button.setAttribute('aria-pressed',String(!hiddenWeightElements.has(button.dataset.element)));}return drawBands(canvas,data,qIndex,modeIndex,{...viewport,segment:$('phonon-segment').value,unit:$('phonon-frequency-unit').value,modeWeights:enabled,hiddenElements:[...hiddenWeightElements],elementColors:Object.fromEntries([...new Set(data.atoms.map(atom=>atom.element))].map(element=>[element,elementColor(element)]))});};
    const frequencyUnit=()=>$('phonon-frequency-unit').value==='THz'?'THz':'cm⁻¹';
    const displayFrequency=value=>value*($('phonon-frequency-unit').value==='THz'?1:WAVENUMBER_PER_THZ);
    const formatFrequency=value=>{const shown=displayFrequency(value);return Math.abs(shown)>0&&Math.abs(shown)<.0001?shown.toExponential(3):shown.toFixed(4);};
    function syncElement(){const element=$('phonon-element').value;const style=appearance[element]||{};const rgb=$('phonon-display-model').value==='vesta'?root.PhononwebsiteVestaStyle?.colorLinear(element):null;const defaultColor=rgb?'#'+rgb.map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join(''):root.ElementStyles[element]?.color;$('phonon-element-color').value=style.color||defaultColor||'#808080';$('phonon-element-radius').value=style.radius_scale||1;}
    function downloadCanvas(){canvas.toBlob(blob=>{if(!blob)return;const link=document.createElement('a'),url=URL.createObjectURL(blob);link.href=url;link.download='phonon-dispersion.png';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});}
    const modeInput = $('phonon-mode'), qInput = $('phonon-q'), amplitude = $('phonon-amplitude'), speed = $('phonon-speed');

    function setStatus(message, isError = false) { status.textContent = message; status.dataset.state = isError ? 'error' : 'ready'; }
    const invalidateStructureAnalysis = () => {
      structureAnalysisGeneration++;
      $('phonon-structure-analysis').hidden = true;
      setStatus('Structure changed · analyze again');
    };
    $('phonon-structure')?.addEventListener('input', invalidateStructureAnalysis);
    $('phonon-format')?.addEventListener('change', invalidateStructureAnalysis);
    $('phonon-analyze-structure')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      const generation = structureAnalysisGeneration;
      const inputText = $('phonon-structure').value, inputFormat = $('phonon-format').value;
      button.disabled = true;
      try {
        setStatus('Analyzing periodic structure…');
        const structure = root.Structures.parse(inputText, inputFormat);
        const result = await root.PhononSymmetry.analyzeStructure(structure, {tolerance: 1e-5});
        if (generation !== structureAnalysisGeneration || inputText !== $('phonon-structure').value || inputFormat !== $('phonon-format').value) {
          setStatus('Structure changed · analyze again');
          return;
        }
        $('phonon-space-group').textContent = `${result.spaceGroupNumber} · ${result.spaceGroupSymbol}`;
        $('phonon-primitive-count').textContent = `${result.primitiveAtoms} atoms from ${result.inputAtoms}`;
        $('phonon-operation-count').textContent = String(result.mapping.operationCount);
        $('phonon-mapping-note').textContent = `Input-to-primitive sites checked; max residual ${result.primitiveSites.maxCartesianResidual.toExponential(2)} Å. Symmetry-operation maps: ${result.mapping.maxCartesianResidual.toExponential(2)} Å.`;
        $('phonon-structure-analysis').hidden = false;
        setStatus('Symmetry analysis complete');
      } catch (error) {
        $('phonon-structure-analysis').hidden = true;
        setStatus(error.message || 'Could not analyze the current structure.', true);
      } finally { button.disabled = false; }
    });
    function nearestPeriodicDistance(){
      const positions=data.atoms.map(atom=>cartesian(atom.fractional,data.lattice));
      let best=Math.min(...data.lattice.map(row=>Math.hypot(...row)));
      const bounds=root.CrystalViewer.bondImageBounds(data.lattice,positions,best);
      for(let i=0;i<positions.length;i++)for(let j=i;j<positions.length;j++)for(let a=-bounds[0];a<=bounds[0];a++)for(let b=-bounds[1];b<=bounds[1];b++)for(let c=-bounds[2];c<=bounds[2];c++){
        if(i===j&&a===0&&b===0&&c===0)continue;
        const shift=cartesian([a,b,c],data.lattice),distance=Math.hypot(...positions[j].map((v,axis)=>v+shift[axis]-positions[i][axis]));
        if(distance>1e-8)best=Math.min(best,distance);
      }
      return best;
    }
    function syncModeScaleDefaults(force=false){
      if(!data?.hasEigenvectors)return;
      const meanMass=data.atoms.reduce((sum,atom)=>sum+(atom.mass||1),0)/data.atoms.length;
      const maxNorm=Math.max(...selected().eigenvector.map((axes,i)=>Math.sqrt(axes.flat().reduce((sum,v)=>sum+v*v,0)*meanMass/(data.atoms[i].mass||1))));
      const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
      const frequency=selected().frequencyTHz,zeroPoint=frequency>0?Math.sqrt(1.054571817e-34/(2*meanMass*1.66053906660e-27*2*Math.PI*frequency*1e12))/1e-10:0;
      const motion=maxNorm>0?clamp(Math.max(zeroPoint,clamp(nearestNeighbor*.12,.08,.22)/maxNorm),.02,5):.2;
      const vector=maxNorm>0?clamp(clamp(nearestNeighbor*.45,.4,1.2)/maxNorm,.15,5):.9;
      const prior=scaleDefaults,next={};
      for(const [key,id,value] of [['motion','phonon-amplitude',motion],['vector','phonon-vector-scale',vector]]){
        const input=$(id),automatic=force||!prior||Math.abs(Number(input.value)-prior[key])<1e-8;
        if(automatic)input.value=String(value);
        // Range inputs quantize values; compare against their actual default.
        if(automatic)next[key]=Number(input.value);else{const temporary=document.createElement('input');temporary.type='range';temporary.min=input.min;temporary.max=input.max;temporary.step=input.step;temporary.value=String(value);next[key]=Number(temporary.value);}
      }
      scaleDefaults=next;
    }
    function selected() { return data?.qpoints[qIndex]?.bands[modeIndex] || null; }
    function syncMode() {
      if (!data) return;
      const mode = selected();syncModeScaleDefaults();
      const activeSegment=data.segments[Number($('phonon-segment').value)];if($('phonon-segment').value!=='all'&&activeSegment&&(qIndex<activeSegment.start||qIndex>activeSegment.end))$('phonon-segment').value='all';
      $('phonon-q-label').textContent = `q ${qIndex + 1} / ${data.qpoints.length} · (${data.qpoints[qIndex].q.map(v => Number(v.toFixed(4))).join(', ')})`;
      $('phonon-mode-label').textContent = `Mode ${modeIndex + 1} · ${formatFrequency(mode.frequencyTHz)} ${frequencyUnit()}${mode.frequencyTHz < 0 ? ' · Imaginary' : ''}`;
      $('phonon-play').disabled = !data.hasEigenvectors;
      $('phonon-reset').disabled = !data.hasEigenvectors;
      $('phonon-q').value = String(qIndex); $('phonon-mode').value = String(modeIndex + 1);$('phonon-q-number').value=String(qIndex+1);
      $('phonon-selection-info').textContent=`q ${qIndex+1} / ${data.qpoints.length} · (${data.qpoints[qIndex].q.map(v=>v.toFixed(5)).join(', ')}) · Mode ${modeIndex+1} / ${data.qpoints[0].bands.length} · ${formatFrequency(mode.frequencyTHz)} ${frequencyUnit()}${mode.frequencyTHz<0?' · Imaginary':''}`;
      for(const [id,disabled] of [['phonon-q-prev',qIndex===0],['phonon-q-next',qIndex===data.qpoints.length-1],['phonon-mode-prev',modeIndex===0],['phonon-mode-next',modeIndex===data.qpoints[0].bands.length-1]])$(id).disabled=disabled;
      redraw(); updateModeStructure();
    }
    root.PhononBand._redraw = redraw;
    function structureAt(currentPhase) {return visualizationFrame(data,{qIndex,modeIndex,repeats:['a','b','c'].map(axis=>Math.max(1,Math.min(4,Math.round(Number($('phonon-repeat-'+axis).value)||1)))),phase:currentPhase,amplitude:Number(amplitude.value),equilibrium});}
    function updateModeStructure() {
      if (!data) return;
      if (!viewer) {viewer = root.CrystalViewer.create($('phonon-crystal'), null, null, null, null);viewer.setViewState({yaw:0,pitch:0,zoom:1});}
      viewer.setFrame({structure: structureAt(phase), display: { ...root.CommonDisplay.frame(),stylePreset: 'phonon-vesta', showCell: $('phonon-show-cell').checked, showBonds: $('phonon-show-bonds').checked, atomScale:Number($('phonon-atom-size').value),bondScale:Number($('phonon-bond-size').value),elementStyles:appearance,vestaDisplay:$('phonon-display-model').value,bondColorByAtom:$('phonon-bond-split').checked,bondColor:$('phonon-bond-color').value,bondCutoffScale:Number($('phonon-bond-cutoff').value),showBoundary: false, showNeighbors: false, showVectors: $('phonon-vectors').checked, vectorScale: Number($('phonon-vector-scale').value),vectorRadius:Number($('phonon-vector-radius').value),vectorColor:$('phonon-vector-color').value, repeats: [1, 1, 1]}, atomDragEnabled: false, interactionMode: 'rotate'});
    }
    function tick(time) {
      if (!playing || !data) return;
      if(previousTime!==null) phase += (time-previousTime) / 1000 * Number(speed.value) * 2 * Math.PI;
      previousTime=time;
      updateModeStructure(); animation = root.requestAnimationFrame(tick);
    }
    function loadResult(parsed, label='Calculated bands') {
      root.cancelAnimationFrame(animation); playing=false;previousTime=null;equilibrium=false;
      $('phonon-play').textContent='Play';data=parsed;qIndex=0;modeIndex=0;phase=0;viewport=null;scaleDefaults=null;nearestNeighbor=nearestPeriodicDistance();
      hiddenWeightElements=new Set();$('phonon-mode-weights').disabled=!data.hasEigenvectors;
      $('phonon-weight-legend').replaceChildren(...[...new Set(data.atoms.map(atom=>atom.element))].map(element=>{const button=document.createElement('button');button.textContent=element;button.dataset.element=element;button.setAttribute('aria-label',element+' mode contribution');button.onclick=()=>{if(hiddenWeightElements.has(element))hiddenWeightElements.delete(element);else hiddenWeightElements.add(element);redraw();};return button;}));
      const result=$('phonon-result');
      $('phonon-results-empty').hidden=true;$('phonon-go-results').disabled=false;
      $('phonon-result-info').textContent=label+' · '+data.atoms.length+' atoms · '+data.qpoints.length+' q-points';
      $('phonon-q-number').max=String(data.qpoints.length);
      const segment=$('phonon-segment');segment.replaceChildren(new Option('All segments','all'));
      data.segments.forEach((part,i)=>segment.add(new Option(`${i+1}: ${(part.labels||['Start','End']).join(' → ')}`,String(i))));
      const elements=$('phonon-element');elements.replaceChildren(...[...new Set(data.atoms.map(atom=>atom.element))].map(element=>new Option(element,element)));syncElement();$('phonon-bond-color').disabled=$('phonon-bond-split').checked;
      qInput.max=String(data.qpoints.length-1);qInput.value='0';modeInput.max=String(data.qpoints[0].bands.length);modeInput.value='1';
      $('phonon-import-note').textContent=`${data.atoms.length} primitive-cell atoms · ${data.qpoints.length} q-points · ${data.segments.length} path segments`;
      $('phonon-no-eigenvectors').hidden=data.hasEigenvectors;$('phonon-result').hidden=false;setStatus(label);syncMode();root.requestAnimationFrame(()=>result.scrollIntoView({block:'start'}));
    }
    root.PhononBand.loadResult=loadResult;
    upload.addEventListener('change', async () => {
      const file = upload.files?.[0]; if (!file) return;
      try {
        setStatus('Reading local file…');
        const parsed = parseBandYaml(await file.text());
        loadResult(parsed, 'Imported · '+file.name);
      } catch (error) { setStatus(error.message || 'Could not read the selected band.yaml.', true); }
    });
    qInput.addEventListener('input', () => { if (!data) return; qIndex = Math.max(0,Math.min(data.qpoints.length-1,Math.round(Number(qInput.value)||0))); syncMode(); });
    modeInput.addEventListener('input', () => { if (!data) return; modeIndex = Math.max(0, Math.min(data.qpoints[0].bands.length - 1, Math.round(Number(modeInput.value)||1) - 1)); syncMode(); });
    for (const id of ['phonon-repeat-a', 'phonon-repeat-b', 'phonon-repeat-c', 'phonon-amplitude', 'phonon-vectors', 'phonon-vector-scale','phonon-vector-radius','phonon-vector-color']) $(id).addEventListener('input', () => { if (data) updateModeStructure(); });
    $('phonon-vector-reset').onclick=()=>{$('phonon-vector-radius').value='.1';$('phonon-vector-color').value='#bbffbb';root.CommonDisplay.patch({vectorRadius:.1,vectorColor:'#bbffbb'});$('phonon-vector-scale').value=String(scaleDefaults?.vector??2);updateModeStructure();};
    $('phonon-play').addEventListener('click', () => { if (!data?.hasEigenvectors) return; playing = !playing; equilibrium=false;previousTime=null; $('phonon-play').textContent = playing ? 'Pause' : 'Play'; if (playing) animation = root.requestAnimationFrame(tick); else root.cancelAnimationFrame(animation); });
    $('phonon-reset').addEventListener('click', () => { playing = false; root.cancelAnimationFrame(animation); phase = 0; equilibrium=true;previousTime=null; $('phonon-play').textContent = 'Play'; updateModeStructure(); });
    function choose(q,mode){if(!data)return;qIndex=Math.max(0,Math.min(data.qpoints.length-1,q));modeIndex=Math.max(0,Math.min(data.qpoints[0].bands.length-1,mode));syncMode();}
    $('phonon-q-number').addEventListener('change',()=>choose(Math.round(Number($('phonon-q-number').value)||1)-1,modeIndex));
    $('phonon-q-prev').onclick=()=>choose(qIndex-1,modeIndex);$('phonon-q-next').onclick=()=>choose(qIndex+1,modeIndex);
    $('phonon-mode-prev').onclick=()=>choose(qIndex,modeIndex-1);$('phonon-mode-next').onclick=()=>choose(qIndex,modeIndex+1);
    $('phonon-segment').addEventListener('change',()=>{if(!data)return;const part=data.segments[Number($('phonon-segment').value)];if($('phonon-segment').value!=='all'&&part){const full=drawBands(canvas,data,qIndex,modeIndex);const xlo=data.qpoints[part.start].distance,xhi=data.qpoints[part.end].distance;viewport=xhi>xlo?{xlo,xhi,lo:full.lo,hi:full.hi}:null;choose(part.start,modeIndex);}else{viewport=null;redraw();}});
    function nearest(px,py,plot){let best=null;const range=$('phonon-segment').value==='all'?null:data.segments[Number($('phonon-segment').value)];
      data.qpoints.forEach((q,qi)=>{if(range&&(qi<range.start||qi>range.end))return;const x=plot.x(qi);if(x<plot.pad.l||x>plot.width-plot.pad.r||Math.abs(x-px)>14)return;q.bands.forEach((band,mi)=>{const y=plot.y(band.frequencyTHz);if(y<plot.pad.t||y>plot.height-plot.pad.b)return;const distance=Math.hypot(x-px,y-py);if(distance<18&&(!best||distance<best.distance))best={qi,mi,distance};});});return best;}
    const location=event=>{const r=canvas.getBoundingClientRect();return [event.clientX-r.left,event.clientY-r.top];};
    canvas.addEventListener('pointerdown',event=>{if(!data||event.button!==0)return;const [x,y]=location(event),plot=redraw();if(x<plot.pad.l||x>plot.width-plot.pad.r||y<plot.pad.t||y>plot.height-plot.pad.b)return;plotDrag={x,y,plot};canvas.setPointerCapture(event.pointerId);});
    canvas.addEventListener('pointermove',event=>{if(!data)return;const [x,y]=location(event),plot=redraw(),tip=$('phonon-plot-tooltip');if(plotDrag){const ctx=canvas.getContext('2d');ctx.fillStyle='#247ab32a';ctx.strokeStyle='#247ab3';ctx.fillRect(plotDrag.x,plotDrag.y,x-plotDrag.x,y-plotDrag.y);ctx.strokeRect(plotDrag.x,plotDrag.y,x-plotDrag.x,y-plotDrag.y);tip.hidden=true;return;}
      const hit=nearest(x,y,plot);tip.hidden=!hit;if(hit){tip.textContent=`${displayFrequency(data.qpoints[hit.qi].bands[hit.mi].frequencyTHz).toFixed(2)} ${frequencyUnit()}`;tip.style.left=Math.max(5,Math.min(plot.width-125,x+12))+'px';tip.style.top=Math.max(5,y-42)+'px';}});
    canvas.addEventListener('pointerleave',()=>{$('phonon-plot-tooltip').hidden=true;});
    canvas.addEventListener('pointercancel',()=>{plotDrag=null;redraw();});
    canvas.addEventListener('pointerup',event=>{if(!plotDrag)return;const start=plotDrag;plotDrag=null;const [px,py]=location(event),plot=start.plot;
      const x=Math.max(plot.pad.l,Math.min(plot.width-plot.pad.r,px)),y=Math.max(plot.pad.t,Math.min(plot.height-plot.pad.b,py));
      if(Math.abs(x-start.x)>10&&Math.abs(y-start.y)>10){viewport={xlo:plot.distanceAt(Math.min(x,start.x)),xhi:plot.distanceAt(Math.max(x,start.x)),lo:plot.frequencyAt(Math.max(y,start.y)),hi:plot.frequencyAt(Math.min(y,start.y))};redraw();}
      else{const hit=nearest(x,y,plot);if(hit)choose(hit.qi,hit.mi);else redraw();}
    });
    function zoom(factor,point){if(!data)return;const plot=redraw(),cx=point?plot.distanceAt(point[0]):(plot.xlo+plot.xhi)/2,cy=point?plot.frequencyAt(point[1]):(plot.lo+plot.hi)/2;
      const fullX=data.qpoints.at(-1).distance||1,span=(plot.xhi-plot.xlo)*factor;if(span<fullX*1e-5)return;
      const xlo=Math.max(0,cx+(plot.xlo-cx)*factor),xhi=Math.min(fullX,cx+(plot.xhi-cx)*factor);if(xhi-xlo<fullX*1e-5)return;
      viewport={xlo,xhi,lo:cy+(plot.lo-cy)*factor,hi:cy+(plot.hi-cy)*factor};redraw();}
    canvas.addEventListener('wheel',event=>{if(!data)return;event.preventDefault();zoom(event.deltaY>0?1.15:1/1.15,location(event));},{passive:false});
    canvas.addEventListener('dblclick',()=>{viewport=null;redraw();});
    canvas.addEventListener('keydown',event=>{if(!data)return;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();choose(qIndex+(event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:0),modeIndex+(event.key==='ArrowUp'?1:event.key==='ArrowDown'?-1:0));}});
    $('phonon-mode-weights').onchange=redraw;
    $('phonon-frequency-unit').onchange=()=>{if(data)syncMode();};
    $('phonon-zoom-in').onclick=()=>zoom(.75);$('phonon-zoom-out').onclick=()=>zoom(1/.75);$('phonon-zoom-reset').onclick=()=>{viewport=null;redraw();};$('phonon-plot-save').onclick=downloadCanvas;
    const goStructure=()=>{$('phonon-structure-stage').scrollIntoView({behavior:'smooth',block:'start'});};
    $('phonon-show-setup').onclick=goStructure;$('phonon-go-structure').onclick=goStructure;
    $('phonon-go-calculate').onclick=()=>{$('phonon-calculation-stage').scrollIntoView({behavior:'smooth',block:'start'});};
    $('phonon-go-results').onclick=()=>{$('phonon-result').scrollIntoView({behavior:'smooth',block:'start'});};
    $('phonon-show-import').onclick=()=>{const panel=document.querySelector('.phonon-import-panel');panel.open=true;panel.scrollIntoView({behavior:'smooth',block:'start'});};
    $('phonon-fullscreen').onclick=async()=>{const panel=document.querySelector('.phonon-visual-panel');try{if(document.fullscreenElement)await document.exitFullscreen();else await panel.requestFullscreen();}catch{const expanded=panel.classList.toggle('phonon-expanded');$('phonon-fullscreen').textContent=expanded?'Exit expanded view':'Expand';}redraw();updateModeStructure();};
    document.addEventListener('fullscreenchange',()=>{$('phonon-fullscreen').textContent=document.fullscreenElement?'Exit fullscreen':'Expand';redraw();updateModeStructure();});
    document.querySelectorAll('[data-phonon-axis]').forEach(button=>button.onclick=()=>viewer?.setCameraAxis(Number(button.dataset.phononAxis)));
    $('phonon-fit').onclick=()=>{viewer?.fitCamera();};$('phonon-projection').onchange=()=>viewer?.setProjection($('phonon-projection').value);
    for(const id of ['phonon-display-model','phonon-atom-size','phonon-show-cell','phonon-show-bonds','phonon-bond-size','phonon-bond-cutoff','phonon-bond-split','phonon-bond-color'])$(id).addEventListener('input',()=>{if(id==='phonon-display-model')syncElement();$('phonon-bond-color').disabled=$('phonon-bond-split').checked;updateModeStructure();redraw();});
    $('phonon-element').onchange=syncElement;
    $('phonon-element-color').oninput=()=>{const element=$('phonon-element').value;appearance[element]={...appearance[element],color:$('phonon-element-color').value};root.CommonDisplay.patch({elementStyles:appearance});updateModeStructure();redraw();};
    $('phonon-element-radius').oninput=()=>{const element=$('phonon-element').value;appearance[element]={...appearance[element],radius_scale:Number($('phonon-element-radius').value)};root.CommonDisplay.patch({elementStyles:appearance});updateModeStructure();};
    $('phonon-reset-appearance').onclick=()=>{root.CommonDisplay.patch({elementStyles:{},atomScale:1,bondScale:1,bondCutoffScale:1,bondColor:'#808080',bondColorByAtom:true});appearance={};for(const [id,value] of [['phonon-atom-size',1],['phonon-bond-size',1],['phonon-bond-cutoff',1],['phonon-bond-color','#808080']])$(id).value=value;$('phonon-bond-split').checked=true;$('phonon-bond-color').disabled=true;syncElement();updateModeStructure();redraw();};
    root.CommonDisplay.subscribe(value=>{appearance=value.elementStyles;syncElement();updateModeStructure();redraw();});
    root.PhononBand.getViewSettings=()=>({camera:viewer?.getViewState(),qIndex,modeIndex,phase,playing,equilibrium,viewport,controls:Object.fromEntries(['phonon-repeat-a','phonon-repeat-b','phonon-repeat-c','phonon-amplitude','phonon-vector-scale','phonon-speed','phonon-frequency-unit','phonon-segment'].map(id=>[id,$(id).value])),arrows:$('phonon-vectors').checked});
    root.PhononBand.restoreViewSettings=value=>{if(!data||!value)return;for(const [id,v] of Object.entries(value.controls||{})){if(['phonon-repeat-a','phonon-repeat-b','phonon-repeat-c','phonon-amplitude','phonon-vector-scale','phonon-speed','phonon-frequency-unit','phonon-segment'].includes(id))$(id).value=v;}qIndex=Math.max(0,Math.min(data.qpoints.length-1,value.qIndex||0));modeIndex=Math.max(0,Math.min(data.qpoints[0].bands.length-1,value.modeIndex||0));phase=Number.isFinite(value.phase)?value.phase:0;equilibrium=!!value.equilibrium;viewport=value.viewport||null;$('phonon-vectors').checked=value.arrows!==false;syncMode();if(value.camera){viewer?.setViewState(value.camera);viewer?.setProjection(value.camera.projection||'perspective');$('phonon-projection').value=value.camera.projection||'perspective';}if(value.playing&&data.hasEigenvectors&&!playing){playing=true;previousTime=null;$('phonon-play').textContent='Pause';animation=root.requestAnimationFrame(tick);}};
    root.addEventListener('resize',redraw);
    if(root.location?.hash==='#phonons')showTab(true);
  }

  root.PhononBand = {parse: parseBandYaml, draw: drawBands, visualizationFrame, modeDisplacement, init: initPhononTab};
  if (root.document) initPhononTab();
})(globalThis);
