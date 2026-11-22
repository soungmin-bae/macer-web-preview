/* Explicit offline shell preparation. Never downloads force-model weights. */
(function(){
 'use strict';
 const button=document.getElementById('prepare-offline-app'),status=document.getElementById('offline-app-status');
 if(!button||!('serviceWorker' in navigator)){if(button)button.disabled=true;if(status)status.textContent='Offline app preparation is unavailable in this browser.';return;}
 const currentPins=Array.from(document.querySelectorAll('script[src], link[rel="stylesheet"][href]')).flatMap(node=>{
  const url=new URL(node.src||node.href,location.href),pin=url.searchParams.get('v');
  return pin&&url.origin===location.origin?[[url.pathname,pin]]:[];
 });
 let checkedAt=0,checking=false;
 async function checkForUpdate(force=false){
  if(checking||(!force&&Date.now()-checkedAt<15000))return;
  checking=true;checkedAt=Date.now();
  try{
   const response=await fetch('./offline-manifest.json',{cache:'no-store'});
   if(!response.ok)return;
   const current=await response.json();
   if(current.schema!=='macer-offline-shell-v1'||!Array.isArray(current.assets)||!/^[a-f0-9]{64}$/.test(current.version))return;
   const published=new Map(current.assets.map(asset=>[new URL(asset.url,location.href).pathname,asset.sha256]));
   if(!currentPins.some(([path,pin])=>published.has(path)&&!published.get(path).startsWith(pin)))return;
   const url=new URL(location.href);
   url.searchParams.set('macer-reload',current.version.slice(0,16));
   const id='macer-reload-latest';
   let link=document.getElementById(id);
   if(!link){
    link=document.createElement('a');
    link.id=id;
    link.textContent='Load latest version';
    status.after(link);
   }
   link.href=url.href;
   status.textContent='A newer version is available. Save any open project before reloading.';
  }catch{/* An offline tab can continue using its verified snapshot. */}
  finally{checking=false;}
 }
 window.addEventListener('pageshow',event=>{if(event.persisted)checkForUpdate(true);});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkForUpdate();});
 checkForUpdate();
 navigator.serviceWorker.getRegistration('./').then(registration=>{
  if(!registration?.active)return;
  status.textContent='App saved for offline reopening. Keep project files separately; browser storage can be cleared or evicted.';
  // Refresh an existing worker's routing code without replacing its verified snapshot.
  registration.update().catch(()=>{});
 }).catch(()=>{});
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
