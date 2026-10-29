/* @ts-self-types="./phonon_kernel.d.ts" */

/**
 * @param {Uint32Array} mesh
 * @param {Float64Array} microzone
 * @param {Float64Array} frequencies
 * @param {Float64Array} weights
 * @param {Float64Array} grid
 * @param {number} atoms
 * @param {number} start
 * @param {number} count
 * @param {number} sigma
 * @returns {Float64Array}
 */
export function phonon_dos_chunk(mesh, microzone, frequencies, weights, grid, atoms, start, count, sigma) {
    const ptr0 = passArray32ToWasm0(mesh, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(microzone, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(frequencies, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(weights, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArrayF64ToWasm0(grid, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.phonon_dos_chunk(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, atoms, start, count, sigma);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v6 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v6;
}

/**
 * @param {Float64Array} force_constants
 * @param {Float64Array} q
 * @param {Float64Array} shortest_vectors_flat
 * @param {Uint32Array} multiplicity_start_flat
 * @param {Float64Array} masses
 * @param {Uint32Array} supercell_to_primitive
 * @param {Uint32Array} primitive_to_fc_row
 * @param {number} primitive_atoms
 * @param {number} supercell_atoms
 * @returns {Float64Array}
 */
export function phonon_dynamical_matrix_at_q(force_constants, q, shortest_vectors_flat, multiplicity_start_flat, masses, supercell_to_primitive, primitive_to_fc_row, primitive_atoms, supercell_atoms) {
    const ptr0 = passArrayF64ToWasm0(force_constants, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(q, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(shortest_vectors_flat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(multiplicity_start_flat, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArrayF64ToWasm0(masses, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArray32ToWasm0(supercell_to_primitive, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArray32ToWasm0(primitive_to_fc_row, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ret = wasm.phonon_dynamical_matrix_at_q(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, primitive_atoms, supercell_atoms);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v8 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v8;
}

/**
 * @param {Float64Array} matrix_interleaved
 * @param {number} dimension
 * @returns {Float64Array}
 */
export function phonon_eigenpairs(matrix_interleaved, dimension) {
    const ptr0 = passArrayF64ToWasm0(matrix_interleaved, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.phonon_eigenpairs(ptr0, len0, dimension);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * @param {number} n_atoms
 * @param {Uint32Array} displaced_dofs
 * @param {Float64Array} displacements
 * @param {Float64Array} force_plus
 * @param {Float64Array} force_minus
 * @returns {Float64Array}
 */
export function phonon_force_constants_central(n_atoms, displaced_dofs, displacements, force_plus, force_minus) {
    const ptr0 = passArray32ToWasm0(displaced_dofs, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(displacements, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(force_plus, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(force_minus, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.phonon_force_constants_central(n_atoms, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v5 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v5;
}

/**
 * @param {number} n_atoms
 * @param {Uint32Array} representative_atoms
 * @param {Float64Array} representative_fc_rows
 * @param {Float64Array} rotations_cartesian_flat
 * @param {Uint32Array} atom_permutations
 * @returns {Float64Array}
 */
export function phonon_force_constants_expand_reduced_rows(n_atoms, representative_atoms, representative_fc_rows, rotations_cartesian_flat, atom_permutations) {
    const ptr0 = passArray32ToWasm0(representative_atoms, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(representative_fc_rows, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(rotations_cartesian_flat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(atom_permutations, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.phonon_force_constants_expand_reduced_rows(n_atoms, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v5 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v5;
}

/**
 * @param {number} n_atoms
 * @param {Float64Array} displacements_flat
 * @param {Float64Array} forces_flat
 * @param {Float64Array} site_rotations_cartesian_flat
 * @param {Uint32Array} atom_permutations
 * @returns {Float64Array}
 */
export function phonon_force_constants_reduced_row(n_atoms, displacements_flat, forces_flat, site_rotations_cartesian_flat, atom_permutations) {
    const ptr0 = passArrayF64ToWasm0(displacements_flat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(forces_flat, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(site_rotations_cartesian_flat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(atom_permutations, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.phonon_force_constants_reduced_row(n_atoms, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v5 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v5;
}

/**
 * Gonze-Lee reciprocal sum (phonopy default, without real-space terms).
 * An empty q0 buffer requests only the unscaled diagonal drift tensor.
 * @param {Float64Array} g_vectors
 * @param {Float64Array} q_cart
 * @param {Float64Array} direction_cart
 * @param {Float64Array} born_flat
 * @param {Float64Array} dielectric_flat
 * @param {Float64Array} positions_flat
 * @param {number} factor
 * @param {number} lambda
 * @param {Float64Array} q0_flat
 * @returns {Float64Array}
 */
export function phonon_gonze_reciprocal(g_vectors, q_cart, direction_cart, born_flat, dielectric_flat, positions_flat, factor, lambda, q0_flat) {
    const ptr0 = passArrayF64ToWasm0(g_vectors, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(q_cart, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(direction_cart, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(born_flat, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArrayF64ToWasm0(dielectric_flat, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArrayF64ToWasm0(positions_flat, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArrayF64ToWasm0(q0_flat, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ret = wasm.phonon_gonze_reciprocal(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, factor, lambda, ptr6, len6);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v8 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v8;
}

/**
 * Reciprocal Niggli reduction used by the HPKOT triclinic path convention.
 * @param {Float64Array} rows
 * @returns {Float64Array}
 */
export function phonon_niggli_reduce(rows) {
    const ptr0 = passArrayF64ToWasm0(rows, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.phonon_niggli_reduce(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * @param {Float64Array} fc
 * @param {Uint32Array} permutations
 * @param {Uint32Array} s2pp
 * @param {Uint32Array} p2s
 * @param {Uint32Array} nsym_list
 * @param {number} n_satom
 * @param {number} level
 * @returns {Float64Array}
 */
export function phonon_symmetrize_compact_fc(fc, permutations, s2pp, p2s, nsym_list, n_satom, level) {
    const ptr0 = passArrayF64ToWasm0(fc, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(permutations, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray32ToWasm0(s2pp, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(p2s, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArray32ToWasm0(nsym_list, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ret = wasm.phonon_symmetrize_compact_fc(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, n_satom, level);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v6 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v6;
}

/**
 * @param {Float64Array} fc
 * @param {number} n_atoms
 * @param {number} level
 * @returns {Float64Array}
 */
export function phonon_symmetrize_full_fc(fc, n_atoms, level) {
    const ptr0 = passArrayF64ToWasm0(fc, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.phonon_symmetrize_full_fc(ptr0, len0, n_atoms, level);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./phonon_kernel_bg.js": import0,
    };
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('phonon_kernel_bg.wasm?v=ee3cc208ae81418a', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
