// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * APPLY-TIME ONLY: project a raw MSCLAP embedding through an already-fit
 * `ProjectionBasis`, then int8-quantize the result.
 *
 * Deliberately separate module from `fit.ts` — nothing in here can compute a
 * basis, only consume one that was handed to it. That split is the whole
 * point: the eval doc measured that comparing a vector encoded under one
 * basis against a vector encoded under a DIFFERENT (even independently
 * well-fit) basis collapses recall@10 from 93.9% to as low as 0.5%, and a
 * basis that silently drifted (refit, reseeded, even just a flipped SVD
 * sign) is indistinguishable from a healthy one by any test that only looks
 * at one basis in isolation. Keeping "compute a basis" and "use a basis" in
 * different files/functions makes it structurally impossible for a caller of
 * `projectAndQuantize` to accidentally refit instead of load.
 */

import type { ProjectionBasis } from './types.js';

/**
 * Project `embedding` (length `basis.inputDim`) through `basis` into a
 * `basis.outputDim`-length float vector. Pure matrix-vector multiply,
 * `embedding^T @ matrix`.
 */
export function projectEmbedding(
    embedding: readonly number[],
    basis: ProjectionBasis,
): Float32Array {
    if (embedding.length !== basis.inputDim) {
        throw new Error(
            `projectEmbedding: embedding length ${embedding.length} does not match basis.inputDim ${basis.inputDim}`,
        );
    }
    const { inputDim, outputDim, matrix } = basis;
    const out = new Float32Array(outputDim);
    for (let i = 0; i < inputDim; i++) {
        const vi = embedding[i];
        if (vi === 0) continue;
        const rowBase = i * outputDim;
        for (let j = 0; j < outputDim; j++) {
            out[j] += vi * matrix[rowBase + j];
        }
    }
    return out;
}

/**
 * Per-vector symmetric max-abs int8 quantization:
 * `q = clip(round(v / max|v| * 127), -127, 127)`.
 *
 * The scale (`max|v|`) is deliberately NOT returned or stored anywhere. The
 * eval doc measured quantization cost at <=0.3pp recall@10 versus float, and
 * cosine similarity is scale-invariant — multiplying every component of a
 * vector by a positive constant never changes its cosine against another
 * vector — so two int8 vectors quantized under DIFFERENT per-vector scales
 * are still directly cosine-comparable. That is what makes 64 raw bytes
 * sufficient with no sidecar float; do not "fix" this by adding one.
 *
 * An all-zero projection (theoretically possible, never observed on real
 * MSCLAP vectors) quantizes to an all-zero int8 vector rather than dividing
 * by zero.
 */
export function quantizeInt8(projected: Float32Array): Int8Array {
    let maxAbs = 0;
    for (let i = 0; i < projected.length; i++) {
        const a = Math.abs(projected[i]);
        if (a > maxAbs) maxAbs = a;
    }
    const out = new Int8Array(projected.length);
    if (maxAbs === 0) return out;
    for (let i = 0; i < projected.length; i++) {
        const q = Math.round((projected[i] / maxAbs) * 127);
        out[i] = Math.max(-127, Math.min(127, q));
    }
    return out;
}

/** `projectEmbedding` + `quantizeInt8` in one call — the apply-path entry point. */
export function projectAndQuantize(
    embedding: readonly number[],
    basis: ProjectionBasis,
): Int8Array {
    return quantizeInt8(projectEmbedding(embedding, basis));
}

/**
 * `Int8Array` -> `Buffer` for a `BYTEA` write. Int8Array's underlying bytes
 * are already the two's-complement encoding Postgres will store verbatim —
 * no re-encoding needed, only a view change.
 */
export function int8VectorToBuffer(vector: Int8Array): Buffer {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * `Buffer`/bytea column read -> `Int8Array`. Copies rather than viewing the
 * source buffer's backing memory, so the result is safe to hold onto after
 * the row buffer is otherwise mutated or pooled.
 */
export function bufferToInt8Vector(buffer: Buffer | Uint8Array): Int8Array {
    const out = new Int8Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
        // Reinterpret the stored byte as signed two's-complement, matching
        // int8VectorToBuffer's encoding.
        const b = buffer[i];
        out[i] = b >= 128 ? b - 256 : b;
    }
    return out;
}

/** Wire encoding: raw int8 bytes -> base64. See api-music-responses.ts for the field description. */
export function int8VectorToBase64(vector: Int8Array): string {
    return int8VectorToBuffer(vector).toString('base64');
}

/** Inverse of `int8VectorToBase64`, exposed for tests / client-parity checks. */
export function base64ToInt8Vector(base64: string): Int8Array {
    return bufferToInt8Vector(Buffer.from(base64, 'base64'));
}

/**
 * THE version-mismatch guard. A stored `(projection_version, projected_vector)`
 * pair is only ever servable when its version matches the codebase's
 * currently active `EMBEDDING_PROJECTION_VERSION` — otherwise this returns
 * `null` and the caller must present the field as absent (client falls back
 * to Essentia), never as a vector under the wrong basis.
 *
 * This is the single choke point every serving path (currently
 * `/music/downloads/candidates`) must route through rather than
 * hand-rolling its own version comparison. The eval doc measured what
 * happens when this guard is silently bypassed and a version-mismatched
 * vector gets served: comparing it against a same-version vector collapses
 * recall@10 from 93.9% (matched) to 16.4-39.4% (mismatched), which is worse
 * than the 5.3% Essentia proxy this feature exists to beat by 18x — so a
 * client that trusted a mismatched vector would be worse off than if the
 * feature didn't exist at all.
 *
 * See `cross-basis.test.ts` for the regression coverage: it mutates this
 * function to ignore the version (i.e. simulates exactly the silent-bypass
 * bug this guard prevents) and confirms the version-mismatch tests fail,
 * which is what makes this guard -- not just its test -- load-bearing.
 */
export function selectServableProjectedVector(
    stored: { version: number; vector: Buffer } | null,
    activeVersion: number,
): Buffer | null {
    if (!stored) return null;
    if (stored.version !== activeVersion) return null;
    return stored.vector;
}
