(function(root){
  'use strict';
  const $=id=>root.document.getElementById(id);
  function init(){
    const file=$('phonondb-file'),button=$('phonondb-import'),cancelButton=$('phonondb-cancel'),status=$('phonondb-status'),canvas=$('phonondb-reference-bands');
    if(!file||!button||!canvas||!root.PhononBand?.draw)return;
    let worker=null,jobId=null,revision=0,reading=false,data=null,qIndex=0,modeIndex=0;
    const licenseReady=()=>!!$('phonondb-record-url').value.trim()&&!!$('phonondb-record-license').value.trim()&&$('phonondb-license-acknowledged').checked;
    function updateButton(){button.disabled=!file.files?.length||!licenseReady()||reading||!!worker;}
    function setStatus(text,isError=false){status.textContent=text;status.dataset.state=isError?'error':'ready';}
    function draw(){
      if(!data)return;
      const plot=root.PhononBand.draw(canvas,data,qIndex,modeIndex,{unit:'cm-1'});
      const band=data.qpoints[qIndex].bands[modeIndex];
      $('phonondb-selection').textContent=`q ${qIndex+1}/${data.qpoints.length} · mode ${modeIndex+1}/${data.qpoints[0].bands.length} · ${(band.frequencyTHz*33.3564095198).toFixed(3)} cm⁻¹`;
      $('phonondb-q-prev').disabled=qIndex===0;$('phonondb-q-next').disabled=qIndex===data.qpoints.length-1;
      $('phonondb-mode-prev').disabled=modeIndex===0;$('phonondb-mode-next').disabled=modeIndex===data.qpoints[0].bands.length-1;
      return plot;
    }
    function select(q,mode){qIndex=Math.max(0,Math.min(data.qpoints.length-1,q));modeIndex=Math.max(0,Math.min(data.qpoints[0].bands.length-1,mode));draw();}
    function stop(message='Import cancelled.'){revision++;reading=false;if(worker){worker.terminate();worker=null;}jobId=null;cancelButton.disabled=true;setStatus(message);updateButton();}
    function renderSource(result){
      data=result.result;
      qIndex=0;modeIndex=0;
      $('phonondb-reference-view').hidden=false;
      const source=result.source;
      $('phonondb-reference-summary').textContent=`Reference only · ${source.primitiveAtoms} primitive atoms · ${source.supercellAtoms} supercell atoms · ${source.displacements} source force sets · space group ${source.spaceGroup} · Phonopy ${source.phonopyVersion}. License: ${source.recordLicense} (user attested). ${source.nacAvailable?'BORN/ε data is present but not applied.':'No BORN/ε pair in the imported file;'} Reference bands do not change the active calculated result.`;
      const link=$('reference-source');link.href=source.url;link.textContent='PhononDB source record';link.hidden=false;
      draw();
      setStatus(`Imported reference bands · ${source.primitiveAtoms} primitive atoms · ${data.qpoints.length} q-points. No model forces were evaluated; NAC was not applied.`);
    }
    function update(event){
      if(event.data?.jobId!==jobId||event.data?.inputRevision!==revision)return;
      const message=event.data;
      if(message.type==='progress')setStatus(message.total?`${message.stage} · ${message.completed}/${message.total}`:`${message.stage}…`);
      else if(message.type==='error'){const text=message.message;worker?.terminate();worker=null;jobId=null;cancelButton.disabled=true;setStatus(text,true);updateButton();}
      else if(message.type==='result'){worker?.terminate();worker=null;jobId=null;cancelButton.disabled=true;renderSource(message);updateButton();}
    }
    file.addEventListener('change',()=>{if(reading||worker)stop('Import cancelled because the selected file changed.');else updateButton();});
    for(const id of ['phonondb-record-url','phonondb-record-license','phonondb-license-acknowledged'])$(id).addEventListener('input',updateButton);
    $('phonondb-license-acknowledged').addEventListener('change',updateButton);
    button.addEventListener('click',async()=>{
      const selected=file.files?.[0];if(!selected)return;
      if(reading||worker)return;
      if(selected.size>25*1024*1024){setStatus('The decompressed YAML exceeds the 25 MiB import limit.',true);return;}
      const readRevision=++revision;reading=true;
      try{
        updateButton();cancelButton.disabled=false;setStatus('Reading local phonopy parameters…');
        const text=await selected.text();
        if(readRevision!==revision)return;
        if(!licenseReady())throw Error('Enter the individual-record license and confirm that you checked it.');
        reading=false;jobId=root.crypto?.randomUUID?.()||`phonondb-${Date.now()}-${readRevision}`;
        worker=new Worker(new URL('./phonondb-import-worker.js',root.location.href));worker.onmessage=update;worker.onerror=event=>{worker?.terminate();worker=null;jobId=null;cancelButton.disabled=true;setStatus(event.message||'The PhononDB import worker failed.',true);updateButton();};
        worker.postMessage({type:'import',jobId,inputRevision:readRevision,text,attribution:{recordUrl:$('phonondb-record-url').value,recordLicense:$('phonondb-record-license').value,licenseAcknowledged:$('phonondb-license-acknowledged').checked}});
      }catch(error){if(readRevision!==revision)return;reading=false;if(worker){worker.terminate();worker=null;}jobId=null;cancelButton.disabled=true;setStatus(error.message||String(error),true);updateButton();}
    });
    cancelButton.addEventListener('click',()=>stop());
    $('phonondb-q-prev').onclick=()=>select(qIndex-1,modeIndex);$('phonondb-q-next').onclick=()=>select(qIndex+1,modeIndex);
    $('phonondb-mode-prev').onclick=()=>select(qIndex,modeIndex-1);$('phonondb-mode-next').onclick=()=>select(qIndex,modeIndex+1);
    canvas.addEventListener('click',event=>{
      if(!data)return;const rect=canvas.getBoundingClientRect(),px=event.clientX-rect.left,py=event.clientY-rect.top,plot=draw();if(!plot)return;
      const distance=plot.distanceAt(px),frequency=plot.frequencyAt(py);let q=0,bestQ=Infinity;
      data.qpoints.forEach((point,index)=>{const d=Math.abs(point.distance-distance);if(d<bestQ){q=index;bestQ=d;}});
      let mode=0,bestMode=Infinity;data.qpoints[q].bands.forEach((band,index)=>{const d=Math.abs(band.frequencyTHz-frequency);if(d<bestMode){mode=index;bestMode=d;}});select(q,mode);
    });
    canvas.addEventListener('keydown',event=>{if(!data)return;if(event.key==='ArrowLeft'){event.preventDefault();select(qIndex-1,modeIndex);}else if(event.key==='ArrowRight'){event.preventDefault();select(qIndex+1,modeIndex);}else if(event.key==='ArrowUp'){event.preventDefault();select(qIndex,modeIndex+1);}else if(event.key==='ArrowDown'){event.preventDefault();select(qIndex,modeIndex-1);}});
    root.addEventListener('resize',draw);updateButton();
  }
  if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})(globalThis);
