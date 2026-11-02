// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { classifyPulledItem, isAtOrAfterCursor } from './jellyfin.js';

describe('jellyfin pull cursor precision', () => {
    // The cursor is written as `lastWatchedAt.toISOString()` — a JS Date, so three
    // fractional digits. Jellyfin returns .NET ticks: seven.
    const CURSOR = '2026-08-27T19:12:49.123Z';

    it('admits a play later in the same millisecond than the cursor', () => {
        // The regression, exactly: as strings, '4' < 'Z' puts this BELOW the cursor,
        // so the old comparison both dropped this play and ended the paged walk.
        expect('2026-08-27T19:12:49.1234567Z' > CURSOR).toBe(false);
        expect(isAtOrAfterCursor('2026-08-27T19:12:49.1234567Z', CURSOR)).toBe(true);
    });

    it('admits the exact boundary rather than risking a lost play', () => {
        expect(isAtOrAfterCursor('2026-08-27T19:12:49.1230000Z', CURSOR)).toBe(true);
    });

    it('still excludes anything genuinely older, so paging terminates', () => {
        expect(isAtOrAfterCursor('2026-08-27T19:12:49.1220000Z', CURSOR)).toBe(false);
        expect(isAtOrAfterCursor('2026-08-27T19:12:48.9999999Z', CURSOR)).toBe(false);
        expect(isAtOrAfterCursor('2026-08-26T00:00:00.0000000Z', CURSOR)).toBe(false);
    });

    it('admits genuinely newer plays', () => {
        expect(isAtOrAfterCursor('2026-08-27T19:12:50.0000000Z', CURSOR)).toBe(true);
        expect(isAtOrAfterCursor('2026-08-28T00:00:00.0000000Z', CURSOR)).toBe(true);
    });

    it('admits rather than truncating the walk when a date is unparseable', () => {
        expect(isAtOrAfterCursor('not-a-date', CURSOR)).toBe(true);
        expect(isAtOrAfterCursor('2026-08-27T19:12:50.0000000Z', 'not-a-date')).toBe(true);
    });

    it('compares correctly when the cursor is the higher-precision side', () => {
        // Defensive: a future writer may keep full precision on the cursor.
        expect(isAtOrAfterCursor('2026-08-27T19:12:49.123Z', '2026-08-27T19:12:49.1234567Z')).toBe(
            true,
        );
    });
});

describe('incremental pull: what to do with each item', () => {
    const CURSOR = '2026-08-27T19:12:49.123Z';

    it('SKIPS an item with no LastPlayedDate instead of re-importing it forever', () => {
        // Undated items were admitted unconditionally, and Jellyfin sorts them
        // FIRST, so every pull re-walked the same block: 818 items per pull, 12
        // pulls an hour, ~9,800 items/hour on prod, flat overnight with nobody
        // watching — and zero watch_history writes to show for it.
        expect(classifyPulledItem(undefined, CURSOR)).toBe('skip');
        expect(classifyPulledItem(null, CURSOR)).toBe('skip');
        expect(classifyPulledItem('', CURSOR)).toBe('skip');
    });

    it('SKIP does not end the walk — the newer items behind it still get imported', () => {
        // The distinction that matters: 'skip' and 'stop' are different verdicts.
        // Treating an undated item as 'stop' would truncate the page and lose real
        // plays sitting behind the undated block.
        expect(classifyPulledItem(undefined, CURSOR)).not.toBe('stop');
    });

    it('TAKES anything at or newer than the cursor', () => {
        expect(classifyPulledItem('2026-08-27T19:12:50.0000000Z', CURSOR)).toBe('take');
        expect(classifyPulledItem('2026-08-27T19:12:49.1234567Z', CURSOR)).toBe('take');
    });

    it('STOPS at the first item older than the cursor', () => {
        expect(classifyPulledItem('2026-08-27T19:12:49.1220000Z', CURSOR)).toBe('stop');
        expect(classifyPulledItem('2026-08-26T00:00:00.0000000Z', CURSOR)).toBe('stop');
    });

    it('agrees with isAtOrAfterCursor on every dated item', () => {
        for (const d of [
            '2026-08-27T19:12:50.0000000Z',
            '2026-08-27T19:12:49.1234567Z',
            '2026-08-27T19:12:49.1230000Z',
            '2026-08-27T19:12:49.1220000Z',
            '2026-08-26T00:00:00.0000000Z',
        ]) {
            expect(classifyPulledItem(d, CURSOR)).toBe(
                isAtOrAfterCursor(d, CURSOR) ? 'take' : 'stop',
            );
        }
    });
});
