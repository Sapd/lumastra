// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { computeGramMatrix, fitUncenteredPcaBasis, matrixToBuffer, bufferToBasis } from './fit.js';

/** Deterministic pseudo-random generator local to this test file (not the fit module's internal one). */
function mulberry32(seed: number): () => number {
    let state = seed | 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A synthetic corpus with concentrated energy in a known low-dim subspace, so PCA has something real to find. */
function makeSyntheticCorpus(
    inputDim: number,
    latentDim: number,
    count: number,
    seed: number,
): number[][] {
    const rand = mulberry32(seed);
    // Fixed latent directions (not orthonormalized — PCA must find the
    // dominant subspace regardless).
    const latentDirs: number[][] = Array.from({ length: latentDim }, (_, d) =>
        Array.from(
            { length: inputDim },
            (_, i) => Math.sin((d + 1) * (i + 1) * 0.37) * (latentDim - d),
        ),
    );
    const vectors: number[][] = [];
    for (let n = 0; n < count; n++) {
        const coeffs = Array.from({ length: latentDim }, () => rand() * 2 - 1);
        const v = new Array<number>(inputDim).fill(0);
        for (let d = 0; d < latentDim; d++) {
            for (let i = 0; i < inputDim; i++) {
                v[i] += coeffs[d] * latentDirs[d][i];
            }
        }
        // small noise across all dims
        for (let i = 0; i < inputDim; i++) {
            v[i] += (rand() - 0.5) * 0.01;
        }
        vectors.push(v);
    }
    return vectors;
}

describe('computeGramMatrix', () => {
    it('computes X^T X for a small known matrix', () => {
        // X = [[1,2],[3,4]] -> X^T X = [[10,14],[14,20]]
        const gram = computeGramMatrix(
            [
                [1, 2],
                [3, 4],
            ],
            2,
        );
        expect(Array.from(gram)).toEqual([10, 14, 14, 20]);
    });

    it('is symmetric', () => {
        const vectors = makeSyntheticCorpus(6, 3, 20, 42);
        const gram = computeGramMatrix(vectors, 6);
        for (let i = 0; i < 6; i++) {
            for (let j = 0; j < 6; j++) {
                expect(gram[i * 6 + j]).toBeCloseTo(gram[j * 6 + i], 8);
            }
        }
    });

    it('throws on a dimension mismatch', () => {
        expect(() => computeGramMatrix([[1, 2, 3]], 2)).toThrow(/inputDim/);
    });
});

describe('fitUncenteredPcaBasis', () => {
    const inputDim = 16;
    const outputDim = 4;

    it('returns an inputDim x outputDim matrix', () => {
        const vectors = makeSyntheticCorpus(inputDim, outputDim, 200, 1);
        const { matrix } = fitUncenteredPcaBasis(vectors, inputDim, outputDim);
        expect(matrix.length).toBe(inputDim * outputDim);
    });

    it('returns orthonormal columns (a valid basis)', () => {
        const vectors = makeSyntheticCorpus(inputDim, outputDim, 200, 2);
        const { matrix } = fitUncenteredPcaBasis(vectors, inputDim, outputDim);

        for (let col = 0; col < outputDim; col++) {
            let normSq = 0;
            for (let i = 0; i < inputDim; i++) {
                normSq += matrix[i * outputDim + col] ** 2;
            }
            expect(normSq).toBeCloseTo(1, 3);
        }
        for (let a = 0; a < outputDim; a++) {
            for (let b = a + 1; b < outputDim; b++) {
                let dot = 0;
                for (let i = 0; i < inputDim; i++) {
                    dot += matrix[i * outputDim + a] * matrix[i * outputDim + b];
                }
                expect(dot).toBeCloseTo(0, 2);
            }
        }
    });

    it('is deterministic: same corpus + same seed produces byte-identical output', () => {
        const vectors = makeSyntheticCorpus(inputDim, outputDim, 200, 3);
        const a = fitUncenteredPcaBasis(vectors, inputDim, outputDim, {
            seed: 777,
            iterations: 40,
        });
        const b = fitUncenteredPcaBasis(vectors, inputDim, outputDim, {
            seed: 777,
            iterations: 40,
        });
        expect(Array.from(a.matrix)).toEqual(Array.from(b.matrix));
    });

    it('recovers most of the concentrated energy of a known low-rank corpus', () => {
        // Corpus energy is concentrated in a `outputDim`-dim subspace by
        // construction (makeSyntheticCorpus) -- the fit basis should capture
        // most of it: projecting through the basis and back should reproduce
        // vectors with only small residual (the injected 0.01-scale noise).
        const vectors = makeSyntheticCorpus(inputDim, outputDim, 300, 4);
        const { matrix } = fitUncenteredPcaBasis(vectors, inputDim, outputDim, { iterations: 80 });

        let totalEnergy = 0;
        let residualEnergy = 0;
        for (const v of vectors.slice(0, 50)) {
            const projected = new Array<number>(outputDim).fill(0);
            for (let i = 0; i < inputDim; i++) {
                for (let j = 0; j < outputDim; j++) {
                    projected[j] += v[i] * matrix[i * outputDim + j];
                }
            }
            const reconstructed = new Array<number>(inputDim).fill(0);
            for (let i = 0; i < inputDim; i++) {
                for (let j = 0; j < outputDim; j++) {
                    reconstructed[i] += projected[j] * matrix[i * outputDim + j];
                }
            }
            for (let i = 0; i < inputDim; i++) {
                totalEnergy += v[i] ** 2;
                residualEnergy += (v[i] - reconstructed[i]) ** 2;
            }
        }
        expect(residualEnergy / totalEnergy).toBeLessThan(0.05);
    });

    it('rejects an empty corpus', () => {
        expect(() => fitUncenteredPcaBasis([], inputDim, outputDim)).toThrow(/empty corpus/);
    });

    it('rejects outputDim > inputDim', () => {
        const vectors = makeSyntheticCorpus(4, 2, 10, 5);
        expect(() => fitUncenteredPcaBasis(vectors, 4, 8)).toThrow(/cannot exceed/);
    });
});

describe('matrixToBuffer / bufferToBasis round-trip', () => {
    it('round-trips a fitted matrix through the BYTEA encoding', () => {
        const vectors = makeSyntheticCorpus(12, 3, 100, 9);
        const { matrix } = fitUncenteredPcaBasis(vectors, 12, 3, { iterations: 30 });

        const buf = matrixToBuffer(matrix);
        expect(buf.byteLength).toBe(12 * 3 * 4);

        const basis = bufferToBasis(buf, {
            version: 5,
            modelId: 'msclap-2023',
            inputDim: 12,
            outputDim: 3,
        });
        expect(basis.version).toBe(5);
        expect(basis.modelId).toBe('msclap-2023');
        expect(Array.from(basis.matrix)).toEqual(Array.from(matrix));
    });

    it('throws on a buffer of the wrong size', () => {
        const buf = Buffer.alloc(10);
        expect(() =>
            bufferToBasis(buf, { version: 1, modelId: 'x', inputDim: 12, outputDim: 3 }),
        ).toThrow(/expected/);
    });
});
