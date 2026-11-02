// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tree-digest formula exists TWICE, and this is the seam that keeps the two
 * copies producing the same bytes.
 *
 *   scripts/plugin-sign.mjs                       computeBundleTreeDigest()
 *   src/.../external-install/archive.ts           computeTreeDigestFromFiles()
 *
 * The duplication is deliberate, not laziness: the signer is a standalone .mjs
 * run by `node` directly (publishers use it outside this repo's build), while
 * the runtime copy is TypeScript behind `$lib` aliases. Neither can import the
 * other without dragging a build step into the other's world.
 *
 * The cost of drift is severe and silent in the worst direction: the signer
 * stamps a `treeDigest` into the SIGNED manifest, and the installer compares it
 * to what it derives from the extracted tree. If the two formulas disagree by so
 * much as a space, EVERY correctly-signed bundle is rejected as tampered — a
 * self-inflicted denial of service on plugin installs, with an error message
 * ("tree digest mismatch") pointing at the publisher rather than at us.
 *
 * So this test pins the formula from both sides against the same inputs, and
 * against a hard-coded expected value so neither side can drift in lockstep.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { computeBundleTreeDigest } from './plugin-sign.mjs';
import { computeTreeDigestFromFiles } from '../src/lib/server/plugins/external-install/archive.ts';

/** {path, data} — the signer's shape (raw file bytes). */
const BUNDLE_FILES = [
    // Deliberately NOT in sorted order: both sides must sort before digesting.
    { path: 'lib/x.js', data: Buffer.from('export const x = 1;\n', 'utf8') },
    { path: 'index.js', data: Buffer.from("import './lib/x.js';\n", 'utf8') },
    { path: 'plugin.json', data: Buffer.from('{"name":"demo"}', 'utf8') },
];

/** {path, sha256, size} — the runtime's shape (post-extraction metadata). */
const EXTRACTED_FILES = BUNDLE_FILES.map((f) => ({
    path: f.path,
    sha256: crypto.createHash('sha256').update(f.data).digest('hex'),
    size: f.data.length,
}));

describe('tree digest — signer and runtime agree', () => {
    it('produces the same digest from raw bytes and from extracted metadata', () => {
        expect(computeBundleTreeDigest(BUNDLE_FILES)).toBe(
            computeTreeDigestFromFiles(EXTRACTED_FILES),
        );
    });

    it('is independent of input order on both sides', () => {
        const reversedBundle = [...BUNDLE_FILES].reverse();
        const reversedExtracted = [...EXTRACTED_FILES].reverse();
        expect(computeBundleTreeDigest(reversedBundle)).toBe(computeBundleTreeDigest(BUNDLE_FILES));
        expect(computeTreeDigestFromFiles(reversedExtracted)).toBe(
            computeTreeDigestFromFiles(EXTRACTED_FILES),
        );
    });

    it('locks the exact formula, so the two cannot drift together', () => {
        // Both sides matching each other is not enough — a change applied to
        // both at once would keep them equal while invalidating every manifest
        // already signed in the wild. This value is the wire format.
        const listing = [...EXTRACTED_FILES]
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
            .map((f) => `${f.sha256}  ${f.size}  ${f.path}\n`)
            .join('');
        const expected = crypto
            .createHash('sha256')
            .update(Buffer.from(listing, 'utf8'))
            .digest('hex');

        expect(computeBundleTreeDigest(BUNDLE_FILES)).toBe(expected);
        expect(computeTreeDigestFromFiles(EXTRACTED_FILES)).toBe(expected);
    });

    it('changes when file CONTENT changes', () => {
        const tampered = BUNDLE_FILES.map((f) =>
            f.path === 'index.js' ? { ...f, data: Buffer.from('evil()\n', 'utf8') } : f,
        );
        expect(computeBundleTreeDigest(tampered)).not.toBe(computeBundleTreeDigest(BUNDLE_FILES));
    });

    it('changes when a file is RENAMED but its content is not', () => {
        // The path is in the listing line, so a moved entry is a different tree
        // even though every byte of content is unchanged.
        const renamed = BUNDLE_FILES.map((f) =>
            f.path === 'lib/x.js' ? { ...f, path: 'lib/y.js' } : f,
        );
        expect(computeBundleTreeDigest(renamed)).not.toBe(computeBundleTreeDigest(BUNDLE_FILES));
    });
});
