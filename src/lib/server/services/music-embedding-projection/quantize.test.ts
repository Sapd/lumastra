// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    projectEmbedding,
    quantizeInt8,
    projectAndQuantize,
    int8VectorToBuffer,
    bufferToInt8Vector,
    int8VectorToBase64,
    base64ToInt8Vector,
} from './quantize.js';
import type { ProjectionBasis } from './types.js';

/** A small deterministic basis for fast, readable tests. Columns are orthonormal by construction. */
function makeTestBasis(version = 1): ProjectionBasis {
    // 4-dim input -> 2-dim output. Column 0 = e0 direction (normalised),
    // column 1 = e1 direction — trivially orthonormal.
    const inputDim = 4;
    const outputDim = 2;
    const matrix = new Float32Array(inputDim * outputDim);
    // row-major: matrix[i*outputDim+j]
    matrix[0 * outputDim + 0] = 1; // e0 -> out0
    matrix[1 * outputDim + 1] = 1; // e1 -> out1
    return { version, modelId: 'msclap-2023', inputDim, outputDim, matrix };
}

describe('projectEmbedding', () => {
    it('applies a matrix-vector multiply against the basis', () => {
        const basis = makeTestBasis();
        const out = projectEmbedding([3, 5, 7, 9], basis);
        expect(Array.from(out)).toEqual([3, 5]);
    });

    it('throws on a dimension mismatch', () => {
        const basis = makeTestBasis();
        expect(() => projectEmbedding([1, 2, 3], basis)).toThrow(/inputDim/);
    });

    it('is deterministic for the same embedding + basis', () => {
        const basis = makeTestBasis();
        const embedding = [1.5, -2.25, 0.75, 3.125];
        const a = projectEmbedding(embedding, basis);
        const b = projectEmbedding(embedding, basis);
        expect(Array.from(a)).toEqual(Array.from(b));
    });
});

describe('quantizeInt8', () => {
    it('scales the largest-magnitude component to +/-127', () => {
        const q = quantizeInt8(Float32Array.from([1, -2, 4, -4]));
        expect(Math.max(...Array.from(q).map(Math.abs))).toBe(127);
        // The two components tied for largest magnitude (4 and -4) hit +-127.
        expect(q[2]).toBe(127);
        expect(q[3]).toBe(-127);
    });

    it('never exceeds the int8 range', () => {
        const q = quantizeInt8(Float32Array.from([100, -100, 50]));
        for (const v of q) {
            expect(v).toBeGreaterThanOrEqual(-127);
            expect(v).toBeLessThanOrEqual(127);
        }
    });

    it('returns an all-zero vector for an all-zero input without dividing by zero', () => {
        const q = quantizeInt8(new Float32Array(8));
        expect(Array.from(q)).toEqual(new Array(8).fill(0));
    });

    it('is deterministic', () => {
        const input = Float32Array.from([0.3, -1.7, 2.9, -0.001]);
        const a = quantizeInt8(input);
        const b = quantizeInt8(input);
        expect(Array.from(a)).toEqual(Array.from(b));
    });
});

describe('projectAndQuantize (apply-path entry point)', () => {
    it('composes projectEmbedding + quantizeInt8 and is deterministic', () => {
        const basis = makeTestBasis();
        const embedding = [2, -6, 0.5, -0.25];
        const a = projectAndQuantize(embedding, basis);
        const b = projectAndQuantize(embedding, basis);
        expect(Array.from(a)).toEqual(Array.from(b));
        expect(a.length).toBe(basis.outputDim);
    });
});

describe('int8 <-> Buffer <-> base64 wire round-trip', () => {
    it('round-trips exactly through Buffer', () => {
        const original = Int8Array.from([127, -127, 0, 1, -1, 63, -63]);
        const buf = int8VectorToBuffer(original);
        const back = bufferToInt8Vector(buf);
        expect(Array.from(back)).toEqual(Array.from(original));
    });

    it('round-trips exactly through base64', () => {
        const original = Int8Array.from(
            Array.from({ length: 64 }, (_, i) => ((i * 37) % 255) - 127),
        );
        const b64 = int8VectorToBase64(original);
        const back = base64ToInt8Vector(b64);
        expect(Array.from(back)).toEqual(Array.from(original));
    });

    it('a real 64-dim quantized vector decodes to EXACTLY 64 bytes on the wire', () => {
        // Simulates the actual wire field: 64-dim projection -> int8 -> base64.
        const basis: ProjectionBasis = {
            version: 1,
            modelId: 'msclap-2023',
            inputDim: 8,
            outputDim: 64,
            matrix: Float32Array.from(Array.from({ length: 8 * 64 }, (_, i) => Math.sin(i) * 0.1)),
        };
        const embedding = Array.from({ length: 8 }, (_, i) => (i + 1) * 0.37);
        const quantized = projectAndQuantize(embedding, basis);
        expect(quantized.length).toBe(64);

        const wireValue = int8VectorToBase64(quantized);
        const decoded = Buffer.from(wireValue, 'base64');
        expect(decoded.byteLength).toBe(64);

        const roundTripped = base64ToInt8Vector(wireValue);
        expect(roundTripped.length).toBe(64);
        expect(Array.from(roundTripped)).toEqual(Array.from(quantized));
    });

    it("negative bytes survive the Buffer round-trip (two's complement encoding check)", () => {
        // Every possible signed int8 value, exercising the full -128..127 byte range
        // bufferToInt8Vector must decode correctly (even though quantizeInt8 itself
        // never emits -128, the buffer helpers must be correct for any byte value).
        const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
        const decoded = bufferToInt8Vector(bytes);
        expect(decoded[0]).toBe(0);
        expect(decoded[127]).toBe(127);
        expect(decoded[128]).toBe(-128);
        expect(decoded[255]).toBe(-1);
    });
});

// The version-mismatch guard (`selectServableProjectedVector`) has its own
// dedicated coverage in `cross-basis.test.ts`, alongside the numeric
// cross-basis recall measurement -- see that file for why the two belong
// together and for the mutation-check this suite is designed to catch.
