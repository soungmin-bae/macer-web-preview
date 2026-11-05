/* Atomic, hash-checked offline app snapshot; no remote requests or model fitting. */
'use strict';
let snapshot;
const hex=buffer=>Array.from(new Uint8Array(buffer),b=>b.toString(16).padStart(2,'0')).join('');
const metadataURL=new URL('./offline-manifest.json',self.location).href;
async function manifest(){
 if(snapshot)return snapshot;
 const version=new URL(self.location).searchParams.get('v');
 if(!/^[a-f0-9]{64}$/.test(version||''))throw Error('Invalid offline snapshot version.');
 const cache=await caches.open('macer-offline-shell-'+version),stored=await cache.match(metadataURL);
 if(!stored)throw Error('Offline snapshot metadata is missing.');
 return snapshot=await stored.json();
}
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const response=await fetch(metadataURL,{cache:'no-store'});if(!response.ok)throw Error('Missing offline manifest.');
 const m=await response.json(),version=new URL(self.location).searchParams.get('v');
 if(m.schema!=='macer-offline-shell-v1'||m.version!==version||!Array.isArray(m.assets)||!m.assets.length)throw Error('Offline manifest changed during preparation.');
 const calculated=hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(m.assets))));
 if(calculated!==version)throw Error('Offline manifest hash mismatch.');
 const cache=await caches.open('macer-offline-shell-'+version);
 for(const asset of m.assets){
  const url=new URL(asset.url,self.location);if(url.origin!==self.location.origin||!url.pathname.startsWith(new URL('./',self.location).pathname)||url.search||url.hash)throw Error('Invalid offline asset URL.');
  const r=await fetch(url.href,{cache:'no-store'});if(!r.ok)throw Error('Missing offline asset '+asset.url);
  const bytes=await r.clone().arrayBuffer();if(bytes.byteLength!==asset.size||hex(await crypto.subtle.digest('SHA-256',bytes))!==asset.sha256)throw Error('Offline asset hash mismatch: '+asset.url);
  await cache.put(url.href,r);
 }
 await cache.put(metadataURL,new Response(JSON.stringify(m),{headers:{'Content-Type':'application/json'}}));snapshot=m;await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
 if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
 event.respondWith((async()=>{
  const m=await manifest(),url=new URL(event.request.url),base=new URL('./',self.location);
  if(url.pathname===base.pathname)url.pathname+='index.html';
  const asset=m.assets.find(a=>new URL(a.url,self.location).pathname===url.pathname);
  if(!asset)return fetch(event.request);
  const version=url.searchParams.get('v');
  if(url.search&&(!version||Array.from(url.searchParams.keys()).some(k=>k!=='v')||!asset.sha256.startsWith(version)))return fetch(event.request);
  const cache=await caches.open('macer-offline-shell-'+m.version),stored=await cache.match(new URL(asset.url,self.location).href);
  return stored||fetch(event.request);
 })());
});
