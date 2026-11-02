// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OFFLINE / ONE-TIME ONLY: fit an uncentered-PCA projection basis from a
 * corpus of raw MSCLAP embeddings.
 *
 * Deliberately separate module from `quantize.ts` (the apply path) and only
 * ever invoked by `music-embedding-projection-fit.ts` — a manually-triggered
 * task that refuses to overwrite an existing basis (see that task's
 * docstring and migration 16.224.0). No code on the write/backfill/request
 * path imports this module; if you find yourself importing `fitUncenteredPcaBasis`
 * from anywhere other than the fit task or this file's own tests, stop — that
 * is very likely an accidental refit, which the eval doc measured drops
 * recall@10 from 93.9% (same basis) to 39.4% (refit) or 16.4% (a single
 * flipped component sign — an ordinary, undetectable-in-isolation
 * consequence of SVD sign being arbitrary across solver/library builds).
 *
 * ## Why uncentered
 *
 * Cosine similarity is not translation-invariant. Mean-centering (the
 * `sklearn.PCA` default) measured 14 points worse at 64 dims (80.1% vs
 * 94.6%) because it optimizes for a metric (Euclidean distance to the mean)
 * that is not the one this feature actually uses (raw cosine, matching the
 * server's `<=>` operator). This fits the top-`outputDim` right-singular
 * vectors of the RAW embedding matrix directly — no mean subtraction
 * anywhere in this file.
 *
 * ## Method: subspace (orthogonal) iteration on the Gram matrix
 *
 * A full SVD of an N x 1024 matrix (N = corpus size, tens of thousands of
 * tracks) is unnecessary: the top-k right-singular vectors of X are exactly
 * the top-k eigenvectors of the 1024x1024 Gram matrix G = X^T X, which does
 * not grow with N. This computes G once (O(N * inputDim^2), the expensive
 * part — the whole reason this is an offline job) then runs subspace
 * iteration (repeated `G @ Q` + re-orthonormalize) to converge Q onto the
 * dominant `outputDim`-eigenspace of G (O(iterations * inputDim^2 *
 * outputDim), independent of N).
 *
 * Note what this does NOT do: it does not sort the returned columns by
 * eigenvalue, and it does not canonicalize component sign. Neither matters
 * for this feature — cosine similarity between two vectors is invariant
 * under any orthonormal rotation of the coordinate system they're both
 * expressed in (that's exactly why the "same basis" row of the eval doc's
 * stability table is measured, not merely assumed), so any orthonormal basis
 * of the same top-k subspace is equally valid PROVIDED every consumer uses
 * the identical basis object. That proviso is what `fit.ts` vs `quantize.ts`
 * plus the DB's fit-once guard exist to enforce.
 */

import type { ProjectionBasis } from './types.js';

/** Deterministic PRNG (mulberry32) so a fit with a fixed seed is reproducible byte-for-byte. */
function mulberry32(seed: number): () => number {
    let state = seed | 0;
    return function next(): number {
        state = (state + 0x6d2b79f5) | 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Accumulate the uncentered Gram matrix `G = X^T X` (`inputDim x inputDim`,
 * row-major `Float64Array`) over a streamed set of vectors. Exploits
 * symmetry (only the upper triangle is accumulated per-vector, then
 * mirrored once at the end) to roughly halve the dominant cost.
 */
export function computeGramMatrix(
    vectors: ReadonlyArray<ArrayLike<number>>,
    inputDim: number,
): Float64Array<ArrayBuffer> {
    const gram = new Float64Array(inputDim * inputDim);
    for (const v of vectors) {
        if (v.length !== inputDim) {
            throw new Error(
                `computeGramMatrix: vector length ${v.length} does not match inputDim ${inputDim}`,
            );
        }
        for (let i = 0; i < inputDim; i++) {
            const vi = v[i];
            if (vi === 0) continue;
            const rowBase = i * inputDim;
            for (let j = i; j < inputDim; j++) {
                gram[rowBase + j] += vi * v[j];
            }
        }
    }
    for (let i = 0; i < inputDim; i++) {
        for (let j = i + 1; j < inputDim; j++) {
            gram[j * inputDim + i] = gram[i * inputDim + j];
        }
    }
    return gram;
}

/** `Z = G @ Q` for `G` (`dim x dim`) and `Q` (`dim x k`, row-major). Returns a new `dim x k` matrix. */
function multiplyGramByBasis(
    gram: Float64Array<ArrayBuffer>,
    q: Float64Array<ArrayBuffer>,
    dim: number,
    k: number,
): Float64Array<ArrayBuffer> {
    const z = new Float64Array(dim * k);
    for (let i = 0; i < dim; i++) {
        const gRowBase = i * dim;
        const zRowBase = i * k;
        for (let col = 0; col < k; col++) {
            let sum = 0;
            for (let j = 0; j < dim; j++) {
                sum += gram[gRowBase + j] * q[j * k + col];
            }
            z[zRowBase + col] = sum;
        }
    }
    return z;
}

/**
 * Orthonormalize the columns of a `dim x k` row-major matrix via modified
 * Gram-Schmidt. Throws on a rank-deficient (near-zero-norm) column, which
 * would indicate a degenerate corpus (fewer independent directions than
 * `outputDim`) rather than a recoverable numerical hiccup.
 */
function orthonormalizeColumns(
    input: Float64Array<ArrayBuffer>,
    dim: number,
    k: number,
): Float64Array<ArrayBuffer> {
    // `new Float64Array(n)` (not `Float64Array.from`) so the return type stays
    // `Float64Array<ArrayBuffer>` -- matching what `new Float64Array(n)` at
    // every call site produces, which `Float64Array.from`'s looser
    // `Float64Array<ArrayBufferLike>` return type does not.
    const q = new Float64Array(input.length);
    q.set(input);
    for (let col = 0; col < k; col++) {
        for (let prev = 0; prev < col; prev++) {
            let dot = 0;
            for (let i = 0; i < dim; i++) {
                dot += q[i * k + col] * q[i * k + prev];
            }
            for (let i = 0; i < dim; i++) {
                q[i * k + col] -= dot * q[i * k + prev];
            }
        }
        let normSq = 0;
        for (let i = 0; i < dim; i++) {
            normSq += q[i * k + col] * q[i * k + col];
        }
        const norm = Math.sqrt(normSq);
        if (!Number.isFinite(norm) || norm < 1e-10) {
            throw new Error(
                `orthonormalizeColumns: column ${col} is rank-deficient (norm=${norm}) -- corpus likely has fewer than ${k} independent directions`,
            );
        }
        for (let i = 0; i < dim; i++) {
            q[i * k + col] /= norm;
        }
    }
    return q;
}

export interface FitOptions {
    /** Subspace-iteration round count. Higher converges tighter component alignment; 100 is generous given this runs once. */
    iterations?: number;
    /** Seed for the deterministic initial random basis. Fixed default so two fits over identical input produce an identical matrix. */
    seed?: number;
}

const DEFAULT_ITERATIONS = 100;
const DEFAULT_SEED = 0x5eed_1024;

/**
 * Fit an uncentered-PCA basis from a corpus of raw embeddings. Pure function
 * — no I/O, no DB, no global state. Returned `matrix` is `inputDim x
 * outputDim` row-major `Float32Array` (widened from the Float64 working
 * precision at the very end, matching the BYTEA wire format).
 *
 * Deterministic for a fixed `(vectors order, inputDim, outputDim, seed,
 * iterations)` tuple — same input always produces the same basis bytes. It
 * is NOT deterministic across different corpora, different vector orderings
 * with floating-point summation, or different seeds, which is precisely the
 * instability the eval doc measured and why this function must only ever be
 * called once per `(model_id, version)` — see the module docstring.
 */
export function fitUncenteredPcaBasis(
    vectors: ReadonlyArray<ArrayLike<number>>,
    inputDim: number,
    outputDim: number,
    options: FitOptions = {},
): { matrix: Float32Array; inputDim: number; outputDim: number } {
    if (vectors.length === 0) {
        throw new Error('fitUncenteredPcaBasis: empty corpus');
    }
    if (outputDim > inputDim) {
        throw new Error(
            `fitUncenteredPcaBasis: outputDim ${outputDim} cannot exceed inputDim ${inputDim}`,
        );
    }

    const iterations = options.iterations ?? DEFAULT_ITERATIONS;
    const seed = options.seed ?? DEFAULT_SEED;

    const gram = computeGramMatrix(vectors, inputDim);

    const rand = mulberry32(seed);
    let q = new Float64Array(inputDim * outputDim);
    for (let i = 0; i < q.length; i++) q[i] = rand() * 2 - 1;
    q = orthonormalizeColumns(q, inputDim, outputDim);

    for (let iter = 0; iter < iterations; iter++) {
        const z = multiplyGramByBasis(gram, q, inputDim, outputDim);
        q = orthonormalizeColumns(z, inputDim, outputDim);
    }

    const matrix = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) matrix[i] = q[i];

    return { matrix, inputDim, outputDim };
}

/** `Float32Array` matrix -> `Buffer` for the `music_embedding_projection_basis.matrix` BYTEA column. */
export function matrixToBuffer(matrix: Float32Array): Buffer {
    return Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength);
}

/** Inverse of `matrixToBuffer` -- reconstructs a `ProjectionBasis` from a DB row. */
export function bufferToBasis(
    buffer: Buffer | Uint8Array,
    meta: { version: number; modelId: string; inputDim: number; outputDim: number },
): ProjectionBasis {
    const expectedBytes = meta.inputDim * meta.outputDim * 4;
    if (buffer.byteLength !== expectedBytes) {
        throw new Error(
            `bufferToBasis: matrix buffer is ${buffer.byteLength} bytes, expected ${expectedBytes} for ${meta.inputDim}x${meta.outputDim} float32`,
        );
    }
    // Copy into a fresh, aligned ArrayBuffer -- a Buffer's byteOffset is not
    // guaranteed to be a multiple of 4, which Float32Array requires.
    const copy = new Uint8Array(buffer).buffer;
    return {
        version: meta.version,
        modelId: meta.modelId,
        inputDim: meta.inputDim,
        outputDim: meta.outputDim,
        matrix: new Float32Array(copy),
    };
}
