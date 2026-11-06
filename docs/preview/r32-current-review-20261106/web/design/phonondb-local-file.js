/* Bounded, user-mediated Phonopy YAML / XZ file reader. */
(function(root){
  'use strict';
  const MiB=1024*1024;
  async function readText(file,{maxBytes=25*MiB,onProgress=()=>{}}={}){
    if(!file||typeof file.stream!=='function'||!Number.isFinite(file.size))throw Error('Choose a local Phonopy YAML or .xz file.');
    if(file.size>maxBytes)throw Error('The selected file exceeds the 25 MiB import limit.');
    const compressed=/\.xz$/i.test(String(file.name||''));
    let stream=file.stream();
    if(compressed){
      const signature=new Uint8Array(await file.slice(0,6).arrayBuffer());
      if(signature.length!==6||signature[0]!==0xfd||signature[1]!==0x37||signature[2]!==0x7a||signature[3]!==0x58||signature[4]!==0x5a||signature[5]!==0x00)throw Error('This .xz file has an invalid XZ signature.');
      if(!root.xzwasm?.XzReadableStream)throw Error('The local XZ decompressor is unavailable. Reload the app and try again.');
      stream=new root.xzwasm.XzReadableStream(stream);
    }
    const reader=stream.getReader(),decoder=new TextDecoder('utf-8',{fatal:true}),parts=[];let bytes=0;
    try{
      while(true){
        const item=await reader.read();if(item.done)break;
        const chunk=item.value instanceof Uint8Array?item.value:new Uint8Array(item.value);
        bytes+=chunk.byteLength;
        if(bytes>maxBytes){await reader.cancel('PhononDB import size limit exceeded.').catch(()=>{});throw Error('The decompressed YAML exceeds the 25 MiB import limit.');}
        parts.push(decoder.decode(chunk,{stream:true}));onProgress(bytes,compressed);
      }
      parts.push(decoder.decode());
    }catch(error){
      await reader.cancel(error).catch(()=>{});
      if(error instanceof TypeError&&/encoded data|decode/i.test(error.message))throw Error('The selected file is not valid UTF-8 YAML.');
      throw error;
    }finally{reader.releaseLock?.();}
    if(bytes===0)throw Error('The selected file is empty.');
    return {text:parts.join(''),format:compressed?'phonopy_params.yaml.xz':'phonopy_params.yaml',bytes};
  }
  root.PhononDbLocalFile=Object.freeze({readText,maxBytes:25*MiB});
})(globalThis);
