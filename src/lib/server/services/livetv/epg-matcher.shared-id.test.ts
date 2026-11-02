// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A playlist can give one guide id to thousands of names. Grouping them is
 * quadratic with an unbounded edit distance, so the matcher must skip such ids
 * and hand the event loop back during its setup.
 */

import { describe, expect, it, vi } from 'vitest';
import { matchEpgChannels, matchEpgChannelsAsync } from './epg-matcher.js';
import type { ProcessedChannel } from './auto-processor.js';
import type { M3uChannel } from './m3u-parser.js';
import type { XmltvChannel, XmltvImportResult } from './xmltv-parser.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

function m3u(name: string): M3uChannel {
    return {
        tvgId: 'shared.de',
        tvgName: undefined,
        name,
        logoUrl: undefined,
        groupTitle: undefined,
        streamUrl: 'http://provider.example/live/1.ts',
        countryCode: undefined,
        extras: {},
    };
}

function processed(names: string[]): ProcessedChannel[] {
    return names.map(
        (name) =>
            ({
                original: m3u(name),
                baseName: name,
                category: '',
                isPrimary: false,
                isVod: false,
            }) as unknown as ProcessedChannel,
    );
}

function guide(): XmltvImportResult {
    const channels: XmltvChannel[] = [
        { id: 'shared.de', displayName: 'Station 0', iconUrl: undefined },
    ];
    return {
        channels,
        programs: [],
        channelCount: 1,
        programCount: 0,
        skipped: 0,
        errors: [],
        warnings: [],
    };
}

const names = (count: number): string[] => Array.from({ length: count }, (_, i) => `Station ${i}`);

describe('one guide id shared by thousands of names', () => {
    it('completes without grouping them and yields before the main loop', async () => {
        // Every clock read jumps 100 ms, so each setup loop yields.
        let clock = 0;
        const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
        const progress: Array<{ processed: number; total: number }> = [];
        const started = Date.now();
        try {
            const result = await matchEpgChannelsAsync(processed(names(5000)), guide(), (p) => {
                progress.push(p);
            });
            expect(result.matches.length).toBeGreaterThan(0);
        } finally {
            nowSpy.mockRestore();
        }
        expect(Date.now() - started).toBeLessThan(10_000);
        // Yields while processed is still 0 come from the setup, not the main loop.
        expect(progress.filter((p) => p.processed === 0).length).toBeGreaterThan(1);
    });

    it('does not group an id with more than 50 station names', () => {
        const started = performance.now();
        matchEpgChannels(processed(names(5000)), guide());
        expect(performance.now() - started).toBeLessThan(2000);
    });

    it('caps a hostile name length before comparing', () => {
        const hostile = Array.from({ length: 40 }, (_, i) => `${'a'.repeat(5000)} ${i}`);
        const started = performance.now();
        matchEpgChannels(processed(hostile), guide());
        expect(performance.now() - started).toBeLessThan(2000);
    });
});
