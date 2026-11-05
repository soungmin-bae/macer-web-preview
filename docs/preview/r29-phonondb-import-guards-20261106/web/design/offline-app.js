/* Explicit offline shell preparation. Never downloads force-model weights. */
(function(){
 'use strict';
 const button=document.getElementById('prepare-offline-app'),status=document.getElementById('offline-app-status');
 if(!button||!('serviceWorker' in navigator)){if(button)button.disabled=true;if(status)status.textContent='Offline app preparation is unavailable in this browser.';return;}
 navigator.serviceWorker.getRegistration('./').then(r=>{if(r?.active)status.textContent='App saved for offline reopening. Keep project files separately; browser storage can be cleared or evicted.';}).catch(()=>{});
 button.onclick=async()=>{
  button.disabled=true;status.textContent='Preparing app files for offline reopening…';
  try{
   const response=await fetch('./offline-manifest.json',{cache:'no-store'});if(!response.ok)throw Error('Offline app manifest is unavailable. Connect to the app server to prepare it.');
   const manifest=await response.json();if(manifest.schema!=='macer-offline-shell-v1'||!/^[a-f0-9]{64}$/.test(manifest.version))throw Error('Invalid offline app manifest.');
   status.textContent=`Saving ${(manifest.assets.reduce((s,a)=>s+a.size,0)/1048576).toFixed(1)} MiB of app and response files. Force-model weights are prepared separately on Run.`;
   const registration=await navigator.serviceWorker.register('./offline-worker.js?v='+manifest.version,{scope:'./',updateViaCache:'none'});
   const worker=registration.installing||registration.waiting||registration.active;
   if(!worker)throw Error('Offline app installation did not start.');
   if(worker.state!=='activated')await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Offline preparation timed out. Reconnect and retry.')),60000);
    const check=()=>{if(worker.state==='activated'){clearTimeout(timer);resolve();}else if(worker.state==='redundant'){clearTimeout(timer);reject(Error('Offline files could not be verified or stored. The previous saved app is retained.'));}};
    worker.addEventListener('statechange',check);check();
   });
   status.textContent='App saved for offline reopening. Save project files too. Only models already prepared on this device can run offline; online structure search needs a connection.';
   button.textContent='Refresh saved offline app';
  }catch(error){status.textContent='Offline app not updated: '+error.message;}
  finally{button.disabled=false;}
 };
})();
