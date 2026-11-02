// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { BundleArtifactSchema, isInvalidBundle, INVALID_BUNDLE } from './bundle-artifact.js';

const good = {
    entry: 'index.js',
    treeDigest: 'a'.repeat(64),
    files: [{ path: 'index.js', sha256: 'b'.repeat(64), size: 10 }],
};

describe('BundleArtifactSchema', () => {
    it('accepts a well-formed artifact', () => {
        expect(BundleArtifactSchema.safeParse(good).success).toBe(true);
    });
    it('rejects bad sha256', () => {
        expect(BundleArtifactSchema.safeParse({ ...good, treeDigest: 'zz' }).success).toBe(false);
        expect(
            BundleArtifactSchema.safeParse({
                ...good,
                files: [{ path: 'x', sha256: 'nope', size: 1 }],
            }).success,
        ).toBe(false);
    });
    it('rejects unsafe path', () => {
        expect(
            BundleArtifactSchema.safeParse({
                ...good,
                files: [{ path: '../x', sha256: 'b'.repeat(64), size: 1 }],
            }).success,
        ).toBe(false);
        expect(BundleArtifactSchema.safeParse({ ...good, entry: '/abs' }).success).toBe(false);
    });
    it('rejects negative size and empty files', () => {
        expect(
            BundleArtifactSchema.safeParse({
                ...good,
                files: [{ path: 'x', sha256: 'b'.repeat(64), size: -1 }],
            }).success,
        ).toBe(false);
        expect(BundleArtifactSchema.safeParse({ ...good, files: [] }).success).toBe(false);
    });
});

describe('invalid-bundle sentinel', () => {
    it('type guard identifies the sentinel', () => {
        expect(isInvalidBundle(INVALID_BUNDLE)).toBe(true);
        expect(isInvalidBundle(good)).toBe(false);
        expect(isInvalidBundle(null)).toBe(false);
    });
});
