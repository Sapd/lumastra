// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared types for the download-pool embedding projection feature.
 * See `.superpowers/embedding-quantization-eval.md` and migration 16.224.0
 * for the measurements and constraints this module implements.
 */

/** Source MSCLAP embedding dimension. Fixed by the model, not configurable. */
export const EMBEDDING_INPUT_DIM = 1024;

/**
 * Output dimension of the quantized projection. 64, not 32 — measured 94.3%
 * vs 86.2% recall@10 (see the eval doc §1); changing this is a full client
 * cache invalidation (new `EMBEDDING_PROJECTION_VERSION`), so it is fixed
 * rather than a parameter threaded through the fit/apply path.
 */
export const EMBEDDING_OUTPUT_DIM = 64;

/**
 * A fit-once, never-recomputed projection basis. `matrix` is row-major
 * `inputDim x outputDim` (i.e. `matrix[i * outputDim + j]` is the weight of
 * input dimension `i` on output dimension `j`) — the top-`outputDim`
 * right-singular vectors of the UNCENTERED embedding matrix (see fit.ts for
 * why uncentered, and quantize.ts for why sign/order within the basis do not
 * matter as long as apply-time always uses this exact object).
 */
export interface ProjectionBasis {
    version: number;
    modelId: string;
    inputDim: number;
    outputDim: number;
    matrix: Float32Array;
}
