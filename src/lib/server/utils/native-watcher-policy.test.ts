// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { buildNativeWatcherPolicy } from './native-watcher-policy.js';
import { isAppleDoubleSidecar, isVendorExcludedName } from './media-file-kinds.js';

vi.mock('./contained-fs.js', () => ({
    getContainmentRoots: async () => [],
    getSensitivePrefixes: async () => [],
}));
vi.mock('./safe-fs.js', () => ({ safeRealpath: async (path: string) => path }));

describe('native watcher serialized eligibility policy', () => {
    it('carries scanner vendor-folder rules and AppleDouble file prefixes', async () => {
        const policy = await buildNativeWatcherPolicy(['/media']);
        for (const name of [
            '@eaDir',
            '#recycle',
            '.Trash-1000',
            '.AppleDouble',
            '.snapshot',
            'Film.mkv.trickplay',
            '.harbor Sign',
            '#Alive (2020)',
        ]) {
            const lower = name.toLowerCase();
            const pruned =
                policy.prunedDirectoryNames.includes(lower) ||
                policy.prunedDirectoryPrefixes.some((prefix) => lower.startsWith(prefix)) ||
                policy.prunedDirectorySuffixes.some((suffix) => lower.endsWith(suffix));
            expect(pruned, name).toBe(isVendorExcludedName(name));
        }
        for (const name of ['._Song.flac', '._Film.mkv', '.Song.flac', '@Artist.flac']) {
            expect(
                policy.ignoredFilePrefixes.some((prefix) => name.startsWith(prefix)),
                name,
            ).toBe(isAppleDoubleSidecar(name));
        }
    });
});
