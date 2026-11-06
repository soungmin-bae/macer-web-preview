'use strict';
importScripts(
  './structures.js',
  './phonon-symmetry.js',
  './atomic-masses.js',
  './seekpath-data.js',
  './phonon-path.js',
  './phonon-nac.js',
  './phonon-engine.js',
  './static_libs/js-yaml-4.1.0.min.js',
  './static_libs/xzwasm-0.1.2.min.js',
  './phonondb-local-file.js',
  './phonondb-import-core.js'
);

let active = null;
let librariesPromise = null;
const emit = (type, fields = {}) => self.postMessage({ type, ...active, ...fields });

function libraries() {
  librariesPromise ||= (async () => {
    const [moyo, kernel] = await Promise.all([
      import('./wasm-moyo/moyo_wasm.js'),
      import('./wasm-phonon/phonon_kernel.js'),
    ]);
    await Promise.all([moyo.default(), kernel.default()]);
    return { moyo, kernel };
  })();
  return librariesPromise;
}

self.onmessage = async ({ data }) => {
  if (data?.type !== 'import') return;
  active = { jobId: data.jobId, inputRevision: data.inputRevision };
  try {
    let text=data.text;
    if(data.file){
      const compressed=/\.xz$/i.test(String(data.fileName||data.file.name||''));
      const loaded=await PhononDbLocalFile.readText(data.file,{onProgress:(bytes,isXz)=>{
        if(active&&data.jobId===active.jobId&&data.inputRevision===active.inputRevision){const amount=bytes>=1024*1024?`${(bytes/1024/1024).toFixed(1)} MiB`:`${Math.ceil(bytes/1024)} KiB`;emit('progress',{stage:`${isXz?'Decompressing local XZ':'Reading local YAML'} · ${amount}`});}
      }});
      if (!active || data.jobId !== active.jobId || data.inputRevision !== active.inputRevision) return;
      text=loaded.text;
      emit('progress',{stage:`Parsing ${compressed?'local XZ':'local YAML'} · ${Math.ceil(loaded.bytes/1024)} KiB`});
    }
    if(typeof text!=='string'||!text.trim())throw Error('Choose a non-empty Phonopy parameter YAML or .xz file.');
    emit('progress', { stage: 'Loading local symmetry and phonon kernels' });
    const { moyo, kernel } = await libraries();
    if (!active || data.jobId !== active.jobId || data.inputRevision !== active.inputRevision) return;
    const imported = await PhononDbImportCore.calculate(
      text,
      data.attribution,
      moyo,
      kernel,
      (stage, completed, total) => emit('progress', { stage, completed, total })
    );
    if (!active || data.jobId !== active.jobId || data.inputRevision !== active.inputRevision) return;
    emit('result', imported);
  } catch (error) {
    if (active && data.jobId === active.jobId && data.inputRevision === active.inputRevision)
      emit('error', { message: String(error?.message || error) });
  }
};
