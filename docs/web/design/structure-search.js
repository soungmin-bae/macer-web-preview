/* Alexandria PBE only. No request occurs before explicit search/selection. */
(function(root){
'use strict';
const ORIGIN='https://alexandria.icams.rub.de',BASE=ORIGIN+'/pbe/v1/',PAGE_LIMIT=20;
const clone=x=>JSON.parse(JSON.stringify(x));
const pages=new Map(),details=new Map();let detailBytes=0;
const summaryFields='chemical_formula_reduced,elements,nsites,_alexandria_space_group,_alexandria_xc_functional,_alexandria_hull_distance';
const detailFields='lattice_vectors,cartesian_site_positions,species,species_at_sites,dimension_types,structure_features,assemblies,chemical_formula_reduced,_alexandria_space_group';
function formula(text){
 const source=String(text).trim().replace(/[₀-₉]/g,c=>String('₀₁₂₃₄₅₆₇₈₉'.indexOf(c)));let at=0;
 function count(){const m=/^\d+/.exec(source.slice(at));if(!m)return 1;at+=m[0].length;const n=Number(m[0]);if(!Number.isSafeInteger(n)||n<1||n>1000000)throw Error('Invalid formula count.');return n;}
 function group(nested){const out={};let terms=0;while(at<source.length&&source[at]!==')'){
  let part;if(source[at]==='('){at++;part=group(true);if(source[at++]!==')')throw Error('Unclosed formula group.');}else{const m=/^[A-Z][a-z]?/.exec(source.slice(at));if(!m)throw Error('Enter a valid chemical formula.');at+=m[0].length;if(!root.Structures?.atomicNumber(m[0]))throw Error('Unknown element '+m[0]+'.');part={[m[0]]:1};}
  const n=count();for(const [e,v]of Object.entries(part)){out[e]=(out[e]||0)+v*n;if(!Number.isSafeInteger(out[e])||out[e]>1000000)throw Error('Formula count is too large.');}terms++;
 }if(!terms)throw Error('Enter a chemical formula.');if(nested&&at===source.length)throw Error('Unclosed formula group.');return out;}
 const values=group(false);if(at!==source.length)throw Error('Unexpected formula character.');const gcd=(a,b)=>b?gcd(b,a%b):a,g=Object.values(values).reduce(gcd);
 return Object.fromEntries(Object.keys(values).sort().map(e=>[e,values[e]/g]));
}
function filter(query,mode){
 if(mode==='id'){const id=String(query).trim();if(!/^[A-Za-z0-9_.:-]{1,100}$/.test(id))throw Error('Enter a valid Alexandria ID.');return 'id='+JSON.stringify(id);}
 const f=mode==='formula'?formula(query):formula(String(query).replace(/[\s,]+/g,'')),elements=Object.keys(f),all='elements HAS ALL '+elements.map(JSON.stringify).join(',');
 if(mode==='formula')return 'chemical_formula_reduced='+JSON.stringify(elements.map(e=>e+(f[e]===1?'':f[e])).join(''));
 if(mode==='only')return all+' AND nelements='+elements.length;
 if(mode==='all')return all;
 throw Error('Unknown search mode.');
}
async function bounded(url,limit,signal,fetcher=root.fetch.bind(root)){
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);if(signal?.aborted)abort();signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(new Error('Search timed out after 15 seconds.')),15000);
 try{const response=await fetcher(url,{credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal,headers:{Accept:'application/json'}});
 if(!response.ok)throw Error(response.status===429?'Search rate limit reached. Please retry later.':'Search request failed (HTTP '+response.status+').');
 if(!response.body)throw Error('Streaming search responses are unavailable.');const reader=response.body.getReader();let n=0;const chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;n+=value.byteLength;if(n>limit){await reader.cancel();throw Error('Search response exceeds '+limit+' bytes.');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(n);let off=0;for(const c of chunks){bytes.set(c,off);off+=c.length;}return {json:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),decodedBytes:n};
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
function cached(map,key){const value=map.get(key);if(!value)return null;if(Date.now()-value.time>600000){map.delete(key);if(map===details)detailBytes-=value.bytes;return null;}map.delete(key);map.set(key,value);return clone(value.value);}
function pageUrl(filterValue,cursor){const url=new URL('structures',BASE);url.searchParams.set('filter',filterValue);url.searchParams.set('page_limit',String(PAGE_LIMIT));url.searchParams.set('response_fields',summaryFields);if(cursor){const n=Number(cursor);if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid next page.');url.searchParams.set('page_offset',String(n));}return url;}
async function search(query,mode='formula',cursor=null,signal){
 const f=filter(query,mode),url=pageUrl(f,cursor),key=url.href,hit=cached(pages,key);if(hit){if(signal?.aborted)throw Error('Search cancelled.');return {...hit,cached:true};}
 const {json,decodedBytes}=await bounded(url.href,65536,signal);if(!Array.isArray(json.data)||json.data.length>20)throw Error('Invalid search result page.');
 const items=json.data.map(x=>({...x.attributes,id:x.id}));for(const x of items){if(typeof x.id!=='string'||!Number.isSafeInteger(x.nsites)||x.nsites<1)throw Error('Invalid structure summary.');if(mode==='formula'&&JSON.stringify(formula(x.chemical_formula_reduced))!==JSON.stringify(formula(query)))throw Error('Search returned a different composition.');if(mode==='only'||mode==='all'){const wanted=Object.keys(formula(String(query).replace(/[\s,]+/g,''))),got=x.elements;if(!Array.isArray(got)||!wanted.every(e=>got.includes(e))||(mode==='only'&&new Set(got).size!==wanted.length))throw Error('Search returned different elements.');}}
 let next=null;if(json.links?.next){const u=new URL(typeof json.links.next==='string'?json.links.next:json.links.next.href);if(u.origin!==ORIGIN||u.pathname!=='/pbe/v1/structures'||u.searchParams.get('filter')!==f)throw Error('Invalid next-page link.');next=u.searchParams.get('page_offset');if(next===null)throw Error('Unsupported next-page cursor.');}
 const value={items,next,decodedBytes};pages.set(key,{time:Date.now(),value});while(pages.size>10)pages.delete(pages.keys().next().value);return clone(value);
}
function structure(record){
 const a=record?.attributes;if(!a||!Array.isArray(a.lattice_vectors)||a.lattice_vectors.length!==3||a.lattice_vectors.some(v=>!Array.isArray(v)||v.length!==3||!v.every(Number.isFinite)))throw Error('Missing or invalid lattice.');
 const cell=a.lattice_vectors;if(!Number.isFinite(root.Structures.determinant(cell))||Math.abs(root.Structures.determinant(cell))<1e-10)throw Error('The structure lattice is singular.');
 if(JSON.stringify(a.dimension_types)!=='[1,1,1]')throw Error('Only fully periodic database structures are supported.');
 if(a.assemblies?.length||a.structure_features?.some(x=>['disorder','assemblies','implicit_atoms','site_attachments'].includes(x)))throw Error('Disordered structures are not supported.');
 const species=new Map();for(const s of a.species||[]){if(species.has(s.name)||s.chemical_symbols?.length!==1||s.concentration?.length!==1||s.concentration[0]!==1||!root.Structures.atomicNumber(s.chemical_symbols[0]))throw Error('Partial occupancy or invalid species is not supported.');species.set(s.name,s.chemical_symbols[0]);}
 const pos=a.cartesian_site_positions,names=a.species_at_sites;if(!Array.isArray(pos)||!pos.length||!Array.isArray(names)||pos.length!==names.length)throw Error('Missing atomic coordinates.');
 const atoms=pos.map((p,i)=>{if(!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite)||!species.has(names[i]))throw Error('Invalid atomic coordinates or species.');return {element:species.get(names[i]),position:p.slice(),mask:[true,true,true]};});
 return {cell:clone(cell),pbc:[true,true,true],atoms,comment:'Alexandria PBE '+record.id,format:'poscar'};
}
async function getStructure(id,signal){
 if(!/^[A-Za-z0-9_.:-]{1,100}$/.test(id))throw Error('Invalid structure ID.');const hit=cached(details,id);if(hit){if(signal?.aborted)throw Error('Search cancelled.');return {...hit,cached:true};}
 const url=new URL('structures/'+encodeURIComponent(id),BASE);url.searchParams.set('response_fields',detailFields);const {json,decodedBytes}=await bounded(url.href,524288,signal);if(json.data?.id!==id)throw Error('Structure ID mismatch.');
 const s=structure(json.data);const counts={};for(const a of s.atoms)counts[a.element]=(counts[a.element]||0)+1;const actual=Object.keys(counts).sort().map(e=>e+counts[e]).join('');if(json.data.attributes.chemical_formula_reduced&&JSON.stringify(formula(actual))!==JSON.stringify(formula(json.data.attributes.chemical_formula_reduced)))throw Error('Detailed structure composition does not match its formula.');const hash=await root.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({cell:s.cell,atoms:s.atoms.map(a=>[a.element,a.position])})));
 const provenance={provider:'Alexandria',dataset:'PBE',id,url:new URL('structures/'+encodeURIComponent(id),BASE).href,license:'CC-BY-4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',attribution:'Alexandria Materials Database',providerTerms:'https://alexandria.icams.rub.de/about.html',originalStructureHash:[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join(''),modified:false,databaseSpaceGroup:json.data.attributes._alexandria_space_group};
 const value={structure:s,provenance,decodedBytes};details.set(id,{time:Date.now(),bytes:decodedBytes,value});detailBytes+=decodedBytes;while(details.size>20||detailBytes>8388608){const key=details.keys().next().value;detailBytes-=details.get(key).bytes;details.delete(key);}return clone(value);
}
function citation(p){return p?.provider==='Alexandria'?`Alexandria ${p.dataset} ${p.id}; ${p.url}; CC BY 4.0 ${p.licenseUrl}; modified: ${p.modified?'yes':'no'}`:'';}
root.StructureSearch=Object.freeze({citation,ORIGIN,formula,filter,search,getStructure,structure,bounded});
if(typeof module!=='undefined')module.exports=root.StructureSearch;
})(globalThis);
