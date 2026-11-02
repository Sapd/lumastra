// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { AdminChannel } from '$lib/schemas/livetv.js';
import { mergeWindowedPayload, reconcileCategoryChannels } from './channel-reconcile.js';

function ch(id: string, isVisible = true): AdminChannel {
    return { id, name: id, isVisible } as AdminChannel;
}

const ids = (channels: AdminChannel[]): string[] => channels.map((c) => c.id);

describe('mergeWindowedPayload', () => {
    // Five rows, a window of the first three.
    const full = ['a', 'b', 'c', 'd', 'e'].map((id) => ch(id));

    it('keeps the unrendered rows after a reorder inside the window', () => {
        const payload = [ch('c'), ch('a'), ch('b')];
        expect(ids(mergeWindowedPayload(full, payload, 3))).toEqual(['c', 'a', 'b', 'd', 'e']);
    });

    it('drops a channel dragged out of the window and keeps the rest', () => {
        const payload = [ch('a'), ch('c')];
        expect(ids(mergeWindowedPayload(full, payload, 3))).toEqual(['a', 'c', 'd', 'e']);
    });

    it('adds a channel dragged in at its drop slot', () => {
        const payload = [ch('a'), ch('x'), ch('b'), ch('c')];
        expect(ids(mergeWindowedPayload(full, payload, 3))).toEqual(['a', 'x', 'b', 'c', 'd', 'e']);
    });

    it('never duplicates a tail channel that appears in the window payload', () => {
        const payload = [ch('e'), ch('a'), ch('b'), ch('c')];
        expect(ids(mergeWindowedPayload(full, payload, 3))).toEqual(['e', 'a', 'b', 'c', 'd']);
    });

    it('returns the payload as is when the whole list was rendered', () => {
        const payload = [ch('e'), ch('d'), ch('c'), ch('b'), ch('a')];
        expect(ids(mergeWindowedPayload(full, payload, 100))).toEqual(['e', 'd', 'c', 'b', 'a']);
    });

    it('keeps hidden channels anchored when combined with the pane reconcile', () => {
        // Store order: a, a² (hidden), b, c, c² (hidden), d. The pane hides hidden
        // channels and renders a window of two visible rows (a, b).
        const store = [ch('a'), ch('a2', false), ch('b'), ch('c'), ch('c2', false), ch('d')];
        const paneVisible = store.filter((c) => c.isVisible); // a, b, c, d
        const windowPayload = [ch('b'), ch('a')]; // swapped inside the window
        const merged = mergeWindowedPayload(paneVisible, windowPayload, 2);
        expect(ids(merged)).toEqual(['b', 'a', 'c', 'd']);
        const result = reconcileCategoryChannels(store, merged, { query: '', hideHidden: true });
        expect(ids(result)).toEqual(['b', 'a', 'a2', 'c', 'c2', 'd']);
    });
});
