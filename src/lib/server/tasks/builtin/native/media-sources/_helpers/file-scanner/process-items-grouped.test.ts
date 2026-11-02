// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { processItems, processItemsGrouped, type ScanOutcome } from './shared.js';

const context = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
} as never;
const newResult = () => ({
    added: 0,
    updated: 0,
    removed: 0,
    unmatched: 0,
    skipped: 0,
    durationMs: 0,
    errors: [] as string[],
});
const tick = () => new Promise((r) => setTimeout(r, 1));

describe('processItemsGrouped', () => {
    const items = ['A/1', 'B/1', 'A/2', 'C/1', 'A/3', 'B/2'];
    const byFolder = (i: string) => i.split('/')[0];

    it('keeps each group in its original order', async () => {
        const seen: string[] = [];
        await processItemsGrouped(
            items,
            byFolder,
            3,
            async (i): Promise<ScanOutcome> => {
                await tick();
                seen.push(i);
                return 'skipped';
            },
            newResult(),
            context,
            () => false,
        );
        expect(seen.filter((i) => i.startsWith('A/'))).toEqual(['A/1', 'A/2', 'A/3']);
        expect(seen.filter((i) => i.startsWith('B/'))).toEqual(['B/1', 'B/2']);
        expect(seen).toHaveLength(items.length);
    });

    it('runs different groups concurrently, never two items of one group at once', async () => {
        let inFlight = 0;
        let peak = 0;
        const busy = new Set<string>();
        await processItemsGrouped(
            items,
            byFolder,
            3,
            async (i): Promise<ScanOutcome> => {
                const group = byFolder(i);
                expect(busy.has(group)).toBe(false);
                busy.add(group);
                peak = Math.max(peak, ++inFlight);
                await tick();
                inFlight--;
                busy.delete(group);
                return 'skipped';
            },
            newResult(),
            context,
            () => false,
        );
        expect(peak).toBe(3); // three groups (A, B, C), width 3
    });

    it('counts outcomes and stops on abort', async () => {
        const result = newResult();
        let n = 0;
        await processItemsGrouped(
            items,
            byFolder,
            1,
            async (): Promise<ScanOutcome> => (++n, 'added'),
            result,
            context,
            () => n >= 2,
        );
        expect(n).toBe(2);
        expect(result.added).toBe(2);
    });
});

// The extras pass hands processItems ExtraEntry objects. Their 'error'
// outcomes land in file_scanner_runs.error_samples — the only record of a file
// whose probe keeps failing transiently — so the entry must name the file,
// not "[object Object]".
describe('processItems — error entries name the file', () => {
    it("uses an item's filePath", async () => {
        const result = newResult();
        await processItems(
            [{ filePath: '/lib/Movie/trailers/t.mkv', extraType: 'trailer' }],
            async () => 'error' as const,
            result,
            context,
            () => false,
        );
        expect(result.errors).toEqual(['/lib/Movie/trailers/t.mkv: processing failed']);
    });

    // Control: a plain string item is unchanged.
    it('keeps a string item as is', async () => {
        const result = newResult();
        await processItems(
            ['/lib/a.mkv'],
            async () => 'error' as const,
            result,
            context,
            () => false,
        );
        expect(result.errors).toEqual(['/lib/a.mkv: processing failed']);
    });
});

it('retains the underlying thrown error separately from the item path', async () => {
    const result = newResult();
    const err = Object.assign(new Error('connection closed'), { code: 'CONNECTION_CLOSED' });
    await processItems(
        ['/Connection Lost (2019).mkv'],
        async () => {
            throw err;
        },
        result,
        context,
        () => false,
    );
    expect(result).toMatchObject({ errorDetails: [{ path: '/Connection Lost (2019).mkv', err }] });
});
