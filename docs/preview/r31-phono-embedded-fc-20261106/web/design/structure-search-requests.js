/* Request generation and cancellation shared by the two structure-search panels. */
(function(root){
  'use strict';
  function create(){
    let generation=0,controller=null;
    return Object.freeze({
      begin(){controller?.abort();controller=new AbortController();return {id:++generation,signal:controller.signal};},
      invalidate(){generation++;controller?.abort();controller=null;return generation;},
      isCurrent(id){return id===generation;},
    });
  }
  root.StructureSearchRequests=Object.freeze({create});
  if(typeof module==='object'&&module.exports)module.exports=root.StructureSearchRequests;
})(globalThis);
