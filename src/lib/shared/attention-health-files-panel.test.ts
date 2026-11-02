// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    HEALTH_FILES_PANEL_PREFIXES,
    isHealthFilesFileHealthItem,
    isHealthFilesIntegrityItem,
    isHealthFilesPanelItem,
} from './attention-health-files-panel.js';
import {
    adaptFileHealth,
    adaptIntegrity,
    adaptMusicHygiene,
} from '$lib/server/services/attention/adapters.js';
import {
    MUSIC_ATTENTION_FINDINGS,
    MUSIC_HYGIENE_FINDINGS,
    MUSIC_HYGIENE_TITLE_FROM_FILENAME,
    MUSIC_HYGIENE_ARTIST_UNSPLIT,
} from './music-hygiene.js';
import type { MusicHygieneCounts } from '$lib/server/database/queries/music-hygiene.queries.js';

function allHygieneCounts(n: number): MusicHygieneCounts {
    const out = {} as MusicHygieneCounts;
    for (const finding of MUSIC_HYGIENE_FINDINGS) out[finding] = n;
    return out;
}

/**
 * Asserted against the REAL adapter output rather than hand-built items.
 *
 * A hand-built fixture would have to restate `type: 'integrity'`, and the whole
 * defect was that a producer picked that near-miss enum member for reasons
 * nothing in this file can see. Driving the predicate off what
 * `adaptMusicHygiene` actually emits means the day it stops reusing `integrity`
 * — or a fifth producer starts — this test is still measuring the real thing.
 */
describe('System → Health "Files" panel membership', () => {
    it('renders what adaptFileHealth and adaptIntegrity emit', () => {
        const items = [...adaptFileHealth(12), ...adaptIntegrity({ 'episode-bad-parent': 3 })];

        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            expect(isHealthFilesPanelItem(item), item.id).toBe(true);
        }
    });

    /**
     * The headline defect. `adaptMusicHygiene` emits `type: 'integrity'` because
     * `AttentionType` is a closed enum it cannot grow without a migration, so a
     * `type`-based filter put music maintenance items inside a panel about file
     * damage, on a page they have nothing to do with.
     *
     * Revert-check (INVERT, not delete): change `isHealthFilesPanelItem` to
     * `item.type === 'file-health' || item.type === 'integrity'` (the code this
     * replaced) and this fails on every emitted finding, while the two assertions
     * around it still pass — which is exactly why neither of them caught it.
     */
    it('excludes every music-hygiene item, though they carry type "integrity"', () => {
        const hygiene = adaptMusicHygiene(allHygieneCounts(7));

        expect(hygiene.map((item) => item.id)).toEqual(
            MUSIC_ATTENTION_FINDINGS.map((finding) => `music-hygiene:${finding}`),
        );
        // Optional filename/conjunction searches never become attention work,
        // even though their fixture counts above are deliberately nonzero.
        // The near-miss enum member is the precondition for the bug; if this
        // ever stops being true the test below is measuring nothing.
        expect(hygiene.some((i) => i.type === 'integrity')).toBe(true);

        for (const item of hygiene) {
            expect(isHealthFilesPanelItem(item), item.id).toBe(false);
            expect(isHealthFilesIntegrityItem(item), `${item.id} link branch`).toBe(false);
        }
    });

    /**
     * The link branch splits the panel's own two producers: an integrity
     * violation is scoped to a `media_items` row, a file-health summary's list
     * is the panel directly below it.
     *
     * Revert-check (CROSS-WIRE): swap the two prefixes in
     * `isHealthFilesIntegrityItem` / `isHealthFilesFileHealthItem` and both
     * halves of this fail.
     */
    it('links integrity items to the browser and file-health items to the panel below', () => {
        const [fileHealth] = adaptFileHealth(12);
        const [integrity] = adaptIntegrity({ 'episode-bad-parent': 3 });

        expect(isHealthFilesIntegrityItem(integrity)).toBe(true);
        expect(isHealthFilesFileHealthItem(integrity)).toBe(false);

        expect(isHealthFilesIntegrityItem(fileHealth)).toBe(false);
        expect(isHealthFilesFileHealthItem(fileHealth)).toBe(true);
    });

    it('does not emit attention for optional filename or conjunction searches', () => {
        const counts = allHygieneCounts(0);
        counts[MUSIC_HYGIENE_TITLE_FROM_FILENAME] = 7;
        counts[MUSIC_HYGIENE_ARTIST_UNSPLIT] = 7;
        expect(adaptMusicHygiene(counts)).toEqual([]);
    });

    it('ignores unrelated producers', () => {
        for (const id of ['scan-run:abc', 'circuit:tmdb-sync', 'unmatched:all', 'gave-up:all']) {
            expect(isHealthFilesPanelItem({ id }), id).toBe(false);
        }
    });

    /** The allowlist is two prefixes; a third would be a deliberate decision. */
    it('allows exactly the two file-oriented producers', () => {
        expect([...HEALTH_FILES_PANEL_PREFIXES]).toEqual(['file-health:', 'integrity:']);
    });
});
