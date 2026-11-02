// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { getChannelViewerStatus, buildChannelIndex } from './channel-viewer-status.js';
import type { AdminChannel, AdminChannelCategory } from '$lib/schemas/livetv.js';

function ch(overrides: Partial<AdminChannel> & { id: string }): AdminChannel {
    return {
        name: overrides.id,
        images: {},
        sortOrder: 0,
        isVisible: true,
        categoryId: 'cat-1',
        ...overrides,
    } as AdminChannel;
}

/** One visible category holding every channel, unless extra categories are given. */
function index(channels: AdminChannel[], extra: AdminChannelCategory[] = []) {
    const cat = {
        id: 'cat-1',
        name: 'Free TV',
        sortOrder: 0,
        isVisible: true,
        channels: channels.filter((c) => c.categoryId === 'cat-1' || c.categoryId === undefined),
    } as AdminChannelCategory;
    return buildChannelIndex([cat, ...extra]);
}

describe('getChannelViewerStatus', () => {
    it('reports an ungrouped visible channel as shown', () => {
        const c = ch({ id: 'a' });
        expect(getChannelViewerStatus(c, true, index([c])).kind).toBe('shown');
    });

    it('reports the group primary as shown', () => {
        const p = ch({ id: 'p', backupGroupId: 'g', groupPrimaryChannelId: 'p' });
        expect(getChannelViewerStatus(p, true, index([p])).kind).toBe('shown');
    });

    // The MTK case: visible, grouped, but not the primary.
    it('reports a non-primary member as superseded, naming the primary', () => {
        const p = ch({
            id: 'p',
            name: 'MTK UHD ¹',
            backupGroupId: 'g',
            groupPrimaryChannelId: 'p',
        });
        const m = ch({ id: 'm', name: 'MTK FHD', backupGroupId: 'g', groupPrimaryChannelId: 'p' });
        expect(getChannelViewerStatus(m, true, index([p, m]))).toEqual({
            kind: 'superseded',
            shownName: 'MTK UHD ¹',
        });
    });

    it("prefers the primary's admin rename over its playlist title", () => {
        const p = ch({
            id: 'p',
            name: 'MTK UHD ¹',
            adminDisplayName: 'MTK 4K',
            backupGroupId: 'g',
            groupPrimaryChannelId: 'p',
        });
        const m = ch({ id: 'm', backupGroupId: 'g', groupPrimaryChannelId: 'p' });
        expect(getChannelViewerStatus(m, true, index([p, m]))).toEqual({
            kind: 'superseded',
            shownName: 'MTK 4K',
        });
    });

    // primary_channel_id is nullable (nulled when the primary row is deleted on
    // refresh): viewers then get the group's first visible feed.
    it('shows the first feed of a group with no primary', () => {
        const a = ch({ id: 'a', sortOrder: 2, backupGroupId: 'g' });
        const b = ch({ id: 'b', sortOrder: 1, backupGroupId: 'g' });
        const idx = index([a, b]);
        expect(getChannelViewerStatus(b, true, idx).kind).toBe('shown');
        expect(getChannelViewerStatus(a, true, idx)).toEqual({
            kind: 'superseded',
            shownName: 'b',
        });
    });

    // A ?sourceId= filtered payload can omit a primary that genuinely exists.
    it('reports superseded-without-a-name when the primary is outside the payload', () => {
        const m = ch({ id: 'm', backupGroupId: 'g', groupPrimaryChannelId: 'elsewhere' });
        expect(getChannelViewerStatus(m, true, index([m]))).toEqual({ kind: 'superseded' });
    });

    // Siebenstern on prod: Configure Lineup hid the "FHD" primary and kept "FHD+".
    // The station stays on air through its first visible feed.
    it('shows the first visible feed when the primary is hidden', () => {
        const p = ch({ id: 'p', isVisible: false, backupGroupId: 'g', groupPrimaryChannelId: 'p' });
        const plus = ch({
            id: 'plus',
            sortOrder: 1,
            backupGroupId: 'g',
            groupPrimaryChannelId: 'p',
        });
        const raw = ch({ id: 'raw', sortOrder: 4, backupGroupId: 'g', groupPrimaryChannelId: 'p' });
        const idx = index([p, plus, raw]);
        expect(getChannelViewerStatus(plus, true, idx).kind).toBe('shown');
        expect(getChannelViewerStatus(raw, true, idx)).toEqual({
            kind: 'superseded',
            shownName: 'plus',
        });
        // The hidden primary is just hidden: it no longer blacks out the group.
        expect(getChannelViewerStatus(p, true, idx).kind).toBe('none');
    });

    it('prefers a normal feed over a transcoded or mobile one, then the better quality', () => {
        const p = ch({ id: 'p', isVisible: false, backupGroupId: 'g', groupPrimaryChannelId: 'p' });
        const trans = ch({
            id: 'trans',
            name: 'Orb Cinema (Transcoded)',
            qualityTier: 'uhd',
            sortOrder: 0,
            backupGroupId: 'g',
            groupPrimaryChannelId: 'p',
        });
        const hd = ch({
            id: 'hd',
            name: 'Orb Cinema HD',
            qualityTier: 'hd',
            sortOrder: 1,
            backupGroupId: 'g',
            groupPrimaryChannelId: 'p',
        });
        const fhd = ch({
            id: 'fhd',
            name: 'Orb Cinema FHD',
            qualityTier: 'fhd',
            sortOrder: 2,
            backupGroupId: 'g',
            groupPrimaryChannelId: 'p',
        });
        const idx = index([p, trans, hd, fhd]);
        expect(getChannelViewerStatus(fhd, true, idx).kind).toBe('shown');
        expect(getChannelViewerStatus(hd, true, idx).kind).toBe('superseded');
        expect(getChannelViewerStatus(trans, true, idx).kind).toBe('superseded');
    });

    it('breaks a sortOrder tie by id, as the viewer query does', () => {
        const b = ch({ id: 'b', backupGroupId: 'g' });
        const a = ch({ id: 'a', backupGroupId: 'g' });
        const idx = index([b, a]);
        expect(getChannelViewerStatus(a, true, idx).kind).toBe('shown');
        expect(getChannelViewerStatus(b, true, idx).kind).toBe('superseded');
    });

    // The primary's own flag is green, but its CATEGORY is hidden: viewers get
    // the member instead.
    it('treats a primary in a hidden category as withheld and shows the member', () => {
        const p = ch({
            id: 'p',
            categoryId: 'cat-hidden',
            backupGroupId: 'g',
            groupPrimaryChannelId: 'p',
        });
        const m = ch({ id: 'm', backupGroupId: 'g', groupPrimaryChannelId: 'p' });
        const idx = buildChannelIndex([
            { id: 'cat-1', name: 'Free TV', sortOrder: 0, isVisible: true, channels: [m] },
            { id: 'cat-hidden', name: 'Hidden', sortOrder: 1, isVisible: false, channels: [p] },
        ] as AdminChannelCategory[]);
        expect(getChannelViewerStatus(m, true, idx).kind).toBe('shown');
    });

    it('reports a visible channel in a hidden category', () => {
        const c = ch({ id: 'a' });
        expect(getChannelViewerStatus(c, false, index([c])).kind).toBe('category-hidden');
    });

    it('treats an uncategorized channel as reachable', () => {
        const p = ch({
            id: 'p',
            categoryId: undefined,
            backupGroupId: 'g',
            groupPrimaryChannelId: 'p',
        });
        const m = ch({ id: 'm', backupGroupId: 'g', groupPrimaryChannelId: 'p' });
        expect(getChannelViewerStatus(m, true, index([p, m])).kind).toBe('superseded');
    });

    it('reports no badge for an ordinary hidden channel', () => {
        const c = ch({ id: 'a', isVisible: false });
        expect(getChannelViewerStatus(c, true, index([c])).kind).toBe('none');
    });
});
