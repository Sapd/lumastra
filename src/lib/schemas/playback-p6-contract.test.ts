// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const source = (path: string): string => readFileSync(path, 'utf8');
it.each([
    ['tests/music-e2e/music-player.e2e.ts', /maxBitRate=/],
    ['tests/playback-stream-limit.ui.spec.ts', /device:\s*\{\s*client:/],
    ['src/task-runtime/vod-worker-continuity.integration.test.ts', /device:\s*\{\s*client:/],
    ['src/lib/api/playback-start.test.ts', /audio:\s*\{[^}]*\bbitrate:/],
] as const)('keeps %s on the public parameter names', (path, retired) => {
    expect(source(path)).not.toMatch(retired);
});
it('publishes the current music stream query parameters', () => {
    const metadata = source('src/routes/api/music/tracks/[id]/stream/_openapi.ts');
    expect(metadata).toContain('maxBitrateKbps:');
    expect(metadata).not.toMatch(/\b(maxBitRate|bitrate|timeOffset):/);
});
it('documents both stream_limit statuses in the problem code tables', () => {
    for (const path of ['docs/api/README.md', 'docs/api/API.md']) {
        const row = source(path)
            .split('\n')
            .find((line) => /^\| `stream_limit`\s*\|/.test(line));
        expect(row).toMatch(/422/);
        expect(row).toMatch(/503/);
        expect(row).toMatch(/VOD/);
    }
});
it('describes the subtitle selector by its public name', () => {
    const def = source('src/lib/server/api/defs/media/[id]/playability.ts');
    expect(def).toContain('`subtitleId`');
    expect(def).not.toContain('`subtitleStreamIndex`');
});
