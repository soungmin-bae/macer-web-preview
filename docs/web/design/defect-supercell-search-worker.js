'use strict';
importScripts('./phonon-supercell-lattice.js?v=a2acac4dca6e61f2b69f3f073db56351cb23980e8fa87310be1efe12fe6131dd');
self.onmessage = ({data: {cell, hostAtoms, minLength, maxAtoms}}) => {
  try {
    self.postMessage({candidates: PhononSupercellLattice.findNearCubicCandidates(cell, hostAtoms, minLength, maxAtoms)});
  } catch (error) {
    self.postMessage({error: error.message});
  }
};
