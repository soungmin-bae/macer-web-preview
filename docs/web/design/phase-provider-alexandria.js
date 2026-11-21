/* Bounded OPTIMADE phase collection. This module does not calculate or infer energies. */
(function (root) {
  'use strict';
  const BASE='https://alexandria.icams.rub.de/pbe/v1/structures';
  const LICENSE='CC-BY-4.0';
  const FIELDS='chemical_formula_reduced,elements,nelements,nsites,species,species_at_sites,lattice_vectors,cartesian_site_positions,_alexandria_energy,_alexandria_hull_distance,_alexandria_space_group';
  const DEFAULTS=Object.freeze({pageLimit:20,requestBudget:256,maxPages:256,maxRecords:20000,maxResponseBytes:1048576,timeoutMs:20000,retries:2,maxRetryDelayMs:2000});
  const SYMBOLS='H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' ');
  const ORDER=new Map(SYMBOLS.map((x,i)=>[x,i]));
  const fail=m=>{throw new TypeError(m);}, finite=x=>typeof x==='number'&&Number.isFinite(x), clone=x=>JSON.parse(JSON.stringify(x));
  const contract=()=>root.PhaseDatasetContract||(typeof require==='function'?require('./phase-dataset.js'):null);
  const MAX_SYSTEM_ELEMENTS=6;
  function normalizeElements(input){
    if(!Array.isArray(input)||input.length<2||input.length>MAX_SYSTEM_ELEMENTS||input.some(e=>!ORDER.has(e))||new Set(input).size!==input.length)fail('Chemical system requires 2–6 unique valid element symbols.');
    return input.slice().sort((a,b)=>ORDER.get(a)-ORDER.get(b));
  }
  function compare(a,b){for(let i=0;i<Math.min(a.length,b.length);i++){const d=ORDER.get(a[i])-ORDER.get(b[i]);if(d)return d;}return a.length-b.length;}
  function enumerateSubsets(elements){
    const e=normalizeElements(elements),out=[];
    for(let mask=1;mask<(1<<e.length);mask++)out.push(e.filter((_,i)=>mask&(1<<i)));
    return out.sort((a,b)=>a.length-b.length||compare(a,b));
  }
  function exactFilter(elements){if(!Array.isArray(elements)||elements.length<1||elements.length>MAX_SYSTEM_ELEMENTS||elements.some(x=>!ORDER.has(x))||new Set(elements).size!==elements.length)fail('Exact subset requires unique valid element symbols.');const e=elements.slice().sort((a,b)=>ORDER.get(a)-ORDER.get(b));return 'elements HAS ALL '+e.map(x=>'"'+x+'"').join(',')+' AND nelements='+e.length;}
  function initialUrl(elements,config){
    const u=new URL(BASE);u.searchParams.set('filter',exactFilter(elements));u.searchParams.set('page_limit',String(config.pageLimit));
    u.searchParams.set('response_fields',FIELDS);u.searchParams.set('sort','_alexandria_hull_distance,id');return u.toString();
  }
  function inverse(cell){
    if(!Array.isArray(cell)||cell.length!==3||cell.some(r=>!Array.isArray(r)||r.length!==3||!r.every(finite)))fail('Alexandria cell must be finite 3×3 lattice vectors.');
    const [a,b,c]=cell,d=a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);
    if(!Number.isFinite(d)||Math.abs(d)<1e-8)fail('Alexandria lattice is singular.');
    return [
      [(b[1]*c[2]-b[2]*c[1])/d,(a[2]*c[1]-a[1]*c[2])/d,(a[1]*b[2]-a[2]*b[1])/d],
      [(b[2]*c[0]-b[0]*c[2])/d,(a[0]*c[2]-a[2]*c[0])/d,(a[2]*b[0]-a[0]*b[2])/d],
      [(b[0]*c[1]-b[1]*c[0])/d,(a[1]*c[0]-a[0]*c[1])/d,(a[0]*b[1]-a[1]*b[0])/d]
    ];
  }
  function rowTimesMatrix(r,m){return [0,1,2].map(j=>r[0]*m[0][j]+r[1]*m[1][j]+r[2]*m[2][j]);}
  function validateConfig(raw){
    const c={...DEFAULTS,...(raw||{})};
    for(const k of Object.keys(DEFAULTS))if(!Number.isSafeInteger(c[k])||c[k]<(k==='retries'?0:1)||(k==='retries'&&c[k]>2))fail('Invalid Alexandria collection budget: '+k+'.');
    if(c.pageLimit>100||c.maxResponseBytes>8388608)fail('Alexandria page or response byte cap is too large.');
    return c;
  }
  function createCollection(elements,options){
    options=options||{};const system=normalizeElements(elements),config=validateConfig(options.config),cutoff=options.cutoff===undefined?.05:options.cutoff;
    if(!finite(cutoff)||cutoff<0)fail('Hull cutoff must be a nonnegative finite eV/atom value.');
    return {schema:'macer-alexandria-phase-collection-v1',schemaVersion:1,chemicalSystem:system,
      providerSnapshot:{provider:'Alexandria PBE OPTIMADE',api:'https://alexandria.icams.rub.de/pbe/v1',license:LICENSE,retrievedAt:null,complete:false,exactSubsetPaginationComplete:false,structureConversionComplete:false},
      config,hullCutoff:{value:cutoff,unit:'eV/atom',comparison:'<='},status:'partial',requestCount:0,pageCount:0,recordCount:0,
      subsets:enumerateSubsets(system).map(e=>({elements:e,filter:exactFilter(e),status:'queued',nextUrl:initialUrl(e,config),seenUrls:[],seenIds:[],pageHashes:[],pageTimestamps:[],pages:0,expectedCount:null,records:[]})),
      phases:[],conversionIssues:[],manualHistory:[],errors:[],cutoffSummary:{within:0,outside:0,unknown:0}};
  }
  function assertNextUrl(raw,subset,config,offset,initial){
    const u=new URL(raw),base=new URL(BASE),q=u.searchParams;
    if(u.protocol!=='https:'||u.origin!==base.origin||u.pathname!==base.pathname||q.get('filter')!==subset.filter||q.get('page_limit')!==String(config.pageLimit)||q.get('response_fields')!==FIELDS||q.get('sort')!=='_alexandria_hull_distance,id')fail('Alexandria next link changed origin, path, filter, fields, order or page size.');
    const value=q.get('page_offset');
    if(initial&&offset===0&&value===null)return 0;
    if(!value||!/^\d+$/.test(value)||Number(value)!==offset)fail('Alexandria pagination cursor is missing, repeated or nonsequential: '+raw+' expected offset '+offset+'.');
    return Number(value);
  }
  function validateCheckpoint(c){
    if(!c||c.schema!=='macer-alexandria-phase-collection-v1'||c.schemaVersion!==1)fail('Alexandria checkpoint schema is unsupported.');
    const system=normalizeElements(c.chemicalSystem),expected=enumerateSubsets(system).map(exactFilter),actual=(c.subsets||[]).map(s=>s.filter);
    if(expected.length!==actual.length||expected.some((x,i)=>x!==actual[i]))fail('Alexandria checkpoint subsets do not match its chemical system.');
    const config=validateConfig(c.config);
    for(const s of c.subsets){
      if(!['queued','partial','complete'].includes(s.status)||!Number.isSafeInteger(s.pages)||s.pages<0||!Array.isArray(s.records)||!Array.isArray(s.seenIds)||!Array.isArray(s.pageHashes)||!Array.isArray(s.pageTimestamps)||!Array.isArray(s.seenUrls)||s.records.length!==s.seenIds.length||new Set(s.seenIds).size!==s.seenIds.length||s.records.some((r,i)=>r.id!==s.seenIds[i])||s.pages!==s.pageHashes.length||s.pages!==s.pageTimestamps.length||s.pages!==s.seenUrls.length)fail('Alexandria checkpoint page records or IDs are corrupt.');
      if(s.nextUrl)assertNextUrl(s.nextUrl,s,config,s.records.length,s.pages===0);
    }
    return clone(c);
  }
  async function verifyCheckpointRecords(c){
    for(const s of c.subsets)for(const record of s.records){
      if(!record.row||record.row.id!==record.id)fail('Alexandria checkpoint record ID does not match its source row.');
      const a=record.row.attributes||{};
      if(!Array.isArray(a.elements)||new Set(a.elements).size!==a.elements.length||a.elements.length!==s.elements.length||s.elements.some(e=>!a.elements.includes(e))||a.nelements!==s.elements.length)fail('Alexandria checkpoint record no longer matches its exact subset.');
      if(await sha(contract().canonicalStringify(record.row))!==record.sha256)fail('Alexandria checkpoint source record hash mismatch for '+record.id+'.');
    }
    return c;
  }
  async function sha(text){
    const bytes=new TextEncoder().encode(text);
    if(root.crypto&&root.crypto.subtle){const d=await root.crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(d),x=>x.toString(16).padStart(2,'0')).join('');}
    if(typeof require==='function')return require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    fail('SHA-256 is unavailable.');
  }
  async function boundedText(response,cap){
    const length=Number(response.headers&&response.headers.get&&response.headers.get('content-length'));
    if(Number.isFinite(length)&&length>cap)fail('Alexandria response exceeds byte cap.');
    if(response.body&&response.body.getReader){
      const reader=response.body.getReader(),chunks=[];let size=0;
      try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>cap){await reader.cancel();fail('Alexandria response exceeds byte cap.');}chunks.push(r.value);}}
      finally{if(reader.releaseLock)reader.releaseLock();}
      const all=new Uint8Array(size);let at=0;for(const b of chunks){all.set(b,at);at+=b.byteLength;}return new TextDecoder('utf-8',{fatal:true}).decode(all);
    }
    const text=await response.text();if(new TextEncoder().encode(text).length>cap)fail('Alexandria response exceeds byte cap.');return text;
  }
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function fetchPage(url,state,options){
    const fetchImpl=options.fetch||root.fetch;if(typeof fetchImpl!=='function')fail('Fetch is unavailable.');
    let lastError;
    for(let attempt=0;attempt<=state.config.retries;attempt++){
      if(options.signal&&options.signal.aborted)throw Object.assign(new Error('Collection cancelled.'),{name:'AbortError'});
      if(state.requestCount>=state.config.requestBudget)return {budget:true};
      state.requestCount++;
      const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),state.config.timeoutMs);
      const signal=options.signal&&AbortSignal.any?AbortSignal.any([options.signal,timeout.signal]):timeout.signal;
      try{
        const response=await fetchImpl(url,{method:'GET',headers:{Accept:'application/vnd.api+json'},signal,cache:'no-store'});
        if(response.status===429||response.status>=500){
          if(attempt<state.config.retries){const retry=Number(response.headers&&response.headers.get&&response.headers.get('retry-after'));const ms=Number.isFinite(retry)?Math.min(state.config.maxRetryDelayMs,Math.max(0,retry*1000)):Math.min(250*Math.pow(2,attempt),state.config.maxRetryDelayMs);await(options.sleep||sleep)(ms);continue;}
          return {retryable:true,status:response.status,retryAfter:response.headers&&response.headers.get&&response.headers.get('retry-after')||null};
        }
        if(!response.ok)return {fatal:true,status:response.status,statusText:response.statusText};
        const text=await boundedText(response,state.config.maxResponseBytes);let payload;
        try{payload=JSON.parse(text);}catch{fail('Alexandria returned invalid JSON.');}
        return {payload,text,status:response.status};
      }catch(error){
        if(options.signal&&options.signal.aborted)throw Object.assign(new Error('Collection cancelled.'),{name:'AbortError'});
        lastError=timeout.signal.aborted?Object.assign(new Error('Alexandria request timed out.'),{name:'TimeoutError'}):error;
        if(attempt>=state.config.retries)throw lastError;
        await(options.sleep||sleep)(Math.min(250*Math.pow(2,attempt),state.config.maxRetryDelayMs));
      }finally{clearTimeout(timer);}
    }
    throw lastError||new Error('Alexandria request failed.');
  }
  function toPhase(row,subset,rowHash){
    const a=row.attributes||{},n=a.nsites,names=a.species_at_sites,species=a.species,cart=a.cartesian_site_positions,cell=a.lattice_vectors;
    if(!Number.isSafeInteger(n)||n<1||!Array.isArray(names)||names.length!==n||!Array.isArray(cart)||cart.length!==n||!Array.isArray(species)||!species.length)fail('Record '+row.id+': atom arrays missing or inconsistent.');
    const map=new Map();
    for(const sp of species){
      if(!sp||typeof sp.name!=='string'||map.has(sp.name)||!Array.isArray(sp.chemical_symbols)||sp.chemical_symbols.length!==1||sp.chemical_symbols[0]==='vacancy'||!Array.isArray(sp.concentration)||sp.concentration.length!==1||Math.abs(sp.concentration[0]-1)>1e-10)fail('Record '+row.id+': disordered/partial occupancy cannot be represented by phase schema v1.');
      map.set(sp.name,sp.chemical_symbols[0]);
    }
    const inv=inverse(cell),atoms=names.map((name,i)=>{
      const element=map.get(name),p=cart[i];if(!element||!subset.elements.includes(element)||!Array.isArray(p)||p.length!==3||!p.every(finite))fail('Record '+row.id+': invalid species or Cartesian site '+i+'.');
      return {element,fractional:rowTimesMatrix(p,inv).map(x=>((x%1)+1)%1)};
    });
    const structure={cell:clone(cell),pbc:[true,true,true],atoms};contract().validateStructure(structure,'Alexandria record '+row.id);
    const hull=a._alexandria_hull_distance,energy=a._alexandria_energy;
    return {phaseId:'alexandria-pbe:'+row.id,source:{provider:'Alexandria PBE OPTIMADE',recordId:row.id,license:LICENSE,
      licenseUrl:'https://resources.psdi.ac.uk/data/optimade-alexandria-alexandria-pbe',recordUrl:BASE+'/'+encodeURIComponent(row.id),subset:subset.elements.slice(),recordSha256:rowHash},
      structure,formula:typeof a.chemical_formula_reduced==='string'?a.chemical_formula_reduced:null,
      providerMetadata:{elements:Array.isArray(a.elements)?a.elements.slice():null,nelements:a.nelements,nsites:n,
        hullDistanceEvPerAtom:finite(hull)?hull:null,hullStatus:finite(hull)?'known':'unknown',energyEv:finite(energy)?energy:null,
        spaceGroup:a._alexandria_space_group===undefined?null:a._alexandria_space_group,exactSubset:subset.elements.slice()}};
  }
  function applyCutoff(c){
    const counts={within:0,outside:0,unknown:0};
    for(const p of c.phases){const h=p.providerMetadata&&p.providerMetadata.hullDistanceEvPerAtom;const x=!finite(h)?'unknown':h<=c.hullCutoff.value?'within':'outside';p.providerMetadata.cutoffStatus=x;counts[x]++;}
    c.hullCutoff={value:c.hullCutoff.value,unit:'eV/atom',comparison:'<='};c.cutoffSummary=counts;return c;
  }
  async function collect(options){
    options=options||{};const c=options.checkpoint?validateCheckpoint(options.checkpoint):createCollection(options.elements,options);
    await verifyCheckpointRecords(c);
    if(JSON.stringify(validateConfig(options.config||c.config))!==JSON.stringify(c.config))fail('Resume configuration differs from frozen checkpoint.');
    const cutoff=options.cutoff===undefined?c.hullCutoff.value:options.cutoff;
    if(!finite(cutoff)||cutoff<0)fail('Hull cutoff must be a nonnegative finite eV/atom value.');
    c.hullCutoff={value:cutoff,unit:'eV/atom',comparison:'<='};
    c.status='partial';c.errors=[];c.requestCount=0;
    const started=Date.now(),globalIds=new Map();for(const s of c.subsets)for(const r of s.records)globalIds.set(r.id,r.sha256);
    const requestBudget=Number.isSafeInteger(options.requestBudget)&&options.requestBudget>0?Math.min(options.requestBudget,c.config.requestBudget):c.config.requestBudget;
    const runConfig={...c.config,requestBudget};const run={requestCount:0,pageCount:c.pageCount,recordCount:globalIds.size,config:runConfig};
    try{
      for(const s of c.subsets){
        if(s.status==='complete')continue;s.status='partial';
        while(s.nextUrl){
          if(options.signal&&options.signal.aborted)throw Object.assign(new Error('Collection cancelled.'),{name:'AbortError'});
          if(run.pageCount>=c.config.maxPages||run.recordCount>=c.config.maxRecords)throw Object.assign(new Error('Total collection limit reached; phase coverage is partial.'),{name:'BudgetError'});
          assertNextUrl(s.nextUrl,s,c.config,s.records.length,s.pages===0);
          if(s.seenUrls.includes(s.nextUrl))fail('Alexandria pagination repeated a request URL.');
          const result=await fetchPage(s.nextUrl,run,options);
          if(result.budget)throw Object.assign(new Error('Request budget reached; checkpoint is resumable.'),{name:'BudgetError'});
          if(result.retryable)throw Object.assign(new Error('Provider retry budget exhausted; checkpoint is resumable.'),{name:'RetryableError',status:result.status,retryAfter:result.retryAfter});
          if(result.fatal)throw Object.assign(new Error('Alexandria HTTP '+result.status+' '+result.statusText),{name:'ProviderError',status:result.status});
          const payload=result.payload,rows=payload&&payload.data,meta=payload&&payload.meta;
          if(!Array.isArray(rows)||!meta||!Number.isSafeInteger(meta.data_returned)||typeof meta.more_data_available!=='boolean')fail('Alexandria page data/pagination metadata is invalid.');
          if(s.expectedCount===null)s.expectedCount=meta.data_returned;
          if(s.expectedCount!==meta.data_returned||rows.length>c.config.pageLimit||(!rows.length&&(s.expectedCount!==0||meta.more_data_available)))fail('Alexandria page count differs from its exact-subset metadata.');
          const ids=rows.map(r=>r&&r.id);if(ids.some(x=>typeof x!=='string'||!x)||new Set(ids).size!==ids.length||ids.some(x=>s.seenIds.includes(x)))fail('Alexandria page contains a missing or duplicate stable record ID.');
          if(s.records.length+rows.length>s.expectedCount)fail('Alexandria page exceeds the exact-subset metadata count.');
          const pageHash=await sha(result.text),next=payload.links&&payload.links.next||null;
          s.seenUrls.push(s.nextUrl);s.pageHashes.push(pageHash);s.pageTimestamps.push(meta.time_stamp||null);s.pages++;run.pageCount++;
          for(const row of rows){
            const rowHash=await sha(contract().canonicalStringify(row)),prior=globalIds.get(row.id);
            if(prior&&prior!==rowHash)fail('Alexandria duplicate ID '+row.id+' changed across exact subsets.');
            s.records.push({id:row.id,sha256:rowHash,row});s.seenIds.push(row.id);
            if(!prior){globalIds.set(row.id,rowHash);run.recordCount++;}
          }
          if(meta.more_data_available){if(!next)fail('Alexandria declared more records but gave no next link.');assertNextUrl(next,s,c.config,s.records.length,false);s.nextUrl=next;}
          else{if(next)fail('Alexandria supplied next link after terminal page.');if(s.records.length!==s.expectedCount)fail('Terminal page count differs from the exact-subset total.');s.nextUrl=null;s.status='complete';}
          c.pageCount=run.pageCount;c.recordCount=run.recordCount;c.requestCount=run.requestCount;
          if(options.onCheckpoint)await options.onCheckpoint(clone(c));
        }
      }
    }catch(error){
      const kind=error&&error.name==='AbortError'?'cancelled':error&&error.name==='BudgetError'?'budget':error&&error.name==='RetryableError'?'rate-limit':error&&error.name==='ProviderError'?'http':error&&error.name==='TimeoutError'?'timeout':'validation';
      c.errors.push({kind,status:error.status||null,retryAfter:error.retryAfter||null,message:String(error.message||error)});
    }
    c.requestCount=run.requestCount;c.pageCount=run.pageCount;c.recordCount=run.recordCount;
    const pagesComplete=c.subsets.every(s=>s.status==='complete'&&s.records.length===s.expectedCount),allRows=new Map();
    for(const s of c.subsets)for(const r of s.records)if(!allRows.has(r.id))allRows.set(r.id,r);
    c.phases=[];c.conversionIssues=[];const convertedIds=new Set();
    for(const s of c.subsets)for(const r of s.records){
      if(convertedIds.has(r.id))continue;
      try{c.phases.push(toPhase(r.row,s,r.sha256));convertedIds.add(r.id);}
      catch(e){c.conversionIssues.push({recordId:r.id,subset:s.elements.slice(),recordSha256:r.sha256,reason:String(e.message||e)});}
    }
    for(const entry of c.manualHistory||[])if(entry.phase&&!convertedIds.has(entry.phaseId)){c.phases.push(clone(entry.phase));convertedIds.add(entry.phaseId);}
    const conversionComplete=c.conversionIssues.length===0;c.status=pagesComplete&&conversionComplete?'complete':'partial';
    c.providerSnapshot.complete=c.status==='complete';c.providerSnapshot.exactSubsetPaginationComplete=pagesComplete;c.providerSnapshot.structureConversionComplete=conversionComplete;
    c.providerSnapshot.retrievedAt=pagesComplete?(c.providerSnapshot.retrievedAt||new Date().toISOString()):null;
    c.providerSnapshot.requestedAt=new Date(started).toISOString();c.providerSnapshot.apiVersion='1.1.0';c.providerSnapshot.recordCount=allRows.size;
    c.providerSnapshot.requestPageCount=c.subsets.reduce((n,s)=>n+s.pages,0);
    c.providerSnapshot.subsetAudit=[];
    for(const s of c.subsets)c.providerSnapshot.subsetAudit.push({elements:s.elements.slice(),filter:s.filter,status:s.status,pageCount:s.pages,
      recordCount:s.records.length,expectedCount:s.expectedCount,pageSha256:s.pageHashes.slice(),providerTimestamps:s.pageTimestamps.slice(),recordIdsSha256:await sha(s.seenIds.slice().sort().join('\\n'))});
    applyCutoff(c);if(options.onCheckpoint)await options.onCheckpoint(clone(c));return clone(c);
  }
  function changeCutoff(input,value){if(!finite(value)||value<0)fail('Hull cutoff must be nonnegative finite eV/atom.');const c=validateCheckpoint(input);c.hullCutoff={value,unit:'eV/atom',comparison:'<='};return clone(applyCutoff(c));}
  function toPhaseDataset(input){
    const c=validateCheckpoint(input);if(!c.phases.length)fail('No convertible provider phases are available.');
    return contract().validateDataset({schema:contract().SCHEMAS.dataset,schemaVersion:1,datasetId:'alexandria-pbe:'+c.chemicalSystem.join('-')+':'+(c.providerSnapshot.retrievedAt||'partial'),
      providerSnapshot:{provider:c.providerSnapshot.provider,retrievedAt:c.providerSnapshot.retrievedAt||new Date().toISOString(),complete:c.providerSnapshot.complete,
        apiVersion:c.providerSnapshot.apiVersion||'1.1.0',source:'https://alexandria.icams.rub.de/pbe/v1',license:LICENSE,
        exactSubsetPaginationComplete:c.providerSnapshot.exactSubsetPaginationComplete,structureConversionComplete:c.providerSnapshot.structureConversionComplete,
        subsetAudit:clone(c.providerSnapshot.subsetAudit)},chemicalSystem:c.chemicalSystem.slice(),hullCutoff:clone(c.hullCutoff),phases:clone(c.phases),manualHistory:clone(c.manualHistory)});
  }
  async function addManualPhase(input,raw,options){
    options=options||{};const c=validateCheckpoint(input),p=clone(raw),api=contract();
    if(!p||!p.structure||!Array.isArray(p.structure.atoms))fail('Manual phase structure is missing.');api.validateStructure(p.structure,'Manual phase');
    if(p.structure.atoms.some(a=>!c.chemicalSystem.includes(a.element)))fail('Manual phase includes an element outside the selected chemical system.');
    const source=String(options.source||'User-supplied structure').slice(0,300),id=p.phaseId||'manual:'+await sha(api.canonicalStringify(p.structure));
    if(c.phases.some(x=>x.phaseId===id||x.source.recordId===id))fail('Manual phase ID already exists.');
    p.phaseId=id;p.source={provider:'Manual import',recordId:id,license:'user-provided',source};
    p.providerMetadata={...(p.providerMetadata||{}),hullDistanceEvPerAtom:null,hullStatus:'unknown',energyEv:null,cutoffStatus:'unknown',manual:true};
    c.phases.push(p);c.manualHistory.push({phaseId:id,source,phase:clone(p),recordSha256:await sha(api.canonicalStringify(p)),addedAt:new Date().toISOString()});return clone(applyCutoff(c));
  }
  function createIndexedDbCheckpointStore(indexedDB){
    indexedDB=indexedDB||root.indexedDB;if(!indexedDB)fail('IndexedDB is unavailable.');
    function open(){return new Promise((resolve,reject)=>{const q=indexedDB.open('macer-thermo-defect-provider-v1',1);q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains('collections'))q.result.createObjectStore('collections');};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error||new Error('Could not open provider checkpoint database.'));});}
    async function write(mode,key,value){const db=await open();return new Promise((resolve,reject)=>{const t=db.transaction('collections',mode),s=t.objectStore('collections');s.put(clone(value),key);t.oncomplete=()=>{db.close();resolve(value);};t.onerror=()=>{db.close();reject(t.error||new Error('Provider checkpoint transaction failed.'));};t.onabort=()=>{db.close();reject(t.error||new Error('Provider checkpoint transaction aborted.'));};});}
    return {save:(key,value)=>write('readwrite',key,value),load:async key=>{const db=await open();return new Promise((resolve,reject)=>{const t=db.transaction('collections','readonly'),q=t.objectStore('collections').get(key);q.onsuccess=()=>resolve(q.result?validateCheckpoint(q.result):null);q.onerror=()=>reject(q.error||new Error('Could not read provider checkpoint.'));t.oncomplete=()=>db.close();t.onerror=()=>{db.close();reject(t.error||new Error('Provider checkpoint read failed.'));};});},remove:async key=>{const db=await open();return new Promise((resolve,reject)=>{const t=db.transaction('collections','readwrite');t.objectStore('collections').delete(key);t.oncomplete=()=>{db.close();resolve();};t.onerror=()=>{db.close();reject(t.error||new Error('Provider checkpoint delete failed.'));};});}};
  }
  const api={BASE,LICENSE,FIELDS,DEFAULTS,MAX_SYSTEM_ELEMENTS,normalizeElements,enumerateSubsets,exactFilter,initialUrl,inverse,createCollection,validateCheckpoint,verifyCheckpointRecords,collect,changeCutoff,toPhaseDataset,addManualPhase,createIndexedDbCheckpointStore};
  root.AlexandriaPhaseProvider=api;if(typeof module==='object'&&module.exports)module.exports=api;
})(typeof globalThis==='object'?globalThis:this);
