// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { get } from 'svelte/store';
import { describe, expect, it, beforeEach } from 'vitest';

import { modalStack, modals, trailPrev } from './modal.store';

describe('modal.store updateProps', () => {
    beforeEach(() => {
        modals.closeAll();
    });

    it('updates props for an existing modal', () => {
        const { id } = modals.open({} as never, { artistId: 'artist-1' });

        modals.updateProps(id, { artistName: 'Moonlit Harbor' });

        expect(get(modalStack)).toHaveLength(1);
        expect(get(modalStack)[0]?.props).toMatchObject({
            artistId: 'artist-1',
            artistName: 'Moonlit Harbor',
        });
    });

    it('is a no-op when the modal no longer exists', async () => {
        const { id } = modals.open({} as never, { albumId: 'album-1' });
        const beforeClose = get(modalStack);

        await modals.closeById(id);
        modals.updateProps(id, { albumTitle: 'Mezzanine' });

        expect(get(modalStack)).toHaveLength(0);
        expect(beforeClose).toHaveLength(1);
    });
});

describe('modal.store openEntity trail model', () => {
    beforeEach(async () => {
        await modals.closeAll();
    });

    it('swaps in place when trailKey matches the top entry', () => {
        modals.openEntity({} as never, { n: 1 }, { trailKey: 'series:abc', trailLabel: 'Show' });
        const firstId = get(modalStack)[0]?.id;
        modals.openEntity({} as never, { n: 2 }, { trailKey: 'series:abc', trailLabel: 'Show' });
        expect(modals.count).toBe(1);
        expect(get(modalStack)[0]?.props).toEqual({ n: 2 });
        // Same id → same keyed block → no remount/backdrop-fade → no flicker.
        expect(get(modalStack)[0]?.id).toBe(firstId);
    });

    it('pushes a new step when trailKey differs (entity jump)', () => {
        modals.openEntity({} as never, { n: 1 }, { trailKey: 'series:abc', trailLabel: 'A' });
        modals.openEntity({} as never, { n: 2 }, { trailKey: 'series:def', trailLabel: 'B' });
        expect(modals.count).toBe(2);
    });

    it('cycle-collapses back to an entity already on the trail', () => {
        modals.openEntity({} as never, {}, { trailKey: 'a', trailLabel: 'A' });
        modals.openEntity({} as never, {}, { trailKey: 'b', trailLabel: 'B' });
        modals.openEntity({} as never, {}, { trailKey: 'c', trailLabel: 'C' });
        modals.openEntity({} as never, { fresh: true }, { trailKey: 'a', trailLabel: 'A' });
        expect(modals.count).toBe(1);
        expect(get(modalStack)[0]?.props).toEqual({ fresh: true });
    });

    it('keeps steps beneath a cycle-collapse target', () => {
        modals.openEntity({} as never, {}, { trailKey: 'a', trailLabel: 'A' });
        modals.openEntity({} as never, {}, { trailKey: 'b', trailLabel: 'B' });
        modals.openEntity({} as never, {}, { trailKey: 'c', trailLabel: 'C' });
        modals.openEntity({} as never, { back: true }, { trailKey: 'b', trailLabel: 'B' });
        expect(modals.count).toBe(2);
        expect(get(modalStack)[0]?.options?.trailKey).toBe('a');
        expect(get(modalStack)[1]?.props).toEqual({ back: true });
    });

    it('drops the oldest step past the soft cap of 8', () => {
        for (let i = 0; i < 10; i++) {
            modals.openEntity({} as never, { i }, { trailKey: `k${i}`, trailLabel: `L${i}` });
        }
        expect(modals.count).toBe(8);
        const stack = get(modalStack);
        expect(stack[stack.length - 1]?.props).toEqual({ i: 9 });
        expect(stack[0]?.options?.trailKey).toBe('k2');
    });

    it('behaves like open when no trailKey is provided', () => {
        modals.openEntity({} as never, { n: 1 });
        modals.openEntity({} as never, { n: 2 });
        expect(modals.count).toBe(2);
    });

    it('trailPrev exposes the entry beneath the top', () => {
        modals.openEntity({} as never, {}, { trailKey: 'a', trailLabel: 'Alpha' });
        expect(get(trailPrev)).toBeNull();
        modals.openEntity({} as never, {}, { trailKey: 'b', trailLabel: 'Beta' });
        expect(get(trailPrev)?.options?.trailLabel).toBe('Alpha');
    });
});

describe('modal.store replace resolves the closed promise', () => {
    beforeEach(async () => {
        await modals.closeAll();
    });

    it('resolves the outgoing entry closed promise on replace', async () => {
        const { closed } = modals.open({} as never, {});
        let resolved = false;
        void closed.then(() => (resolved = true));
        modals.replace({} as never, {});
        await Promise.resolve();
        expect(resolved).toBe(true);
    });
});

describe('modal.store closeAll honors top beforeClose veto', () => {
    beforeEach(async () => {
        await modals.closeAll();
    });

    it('aborts while the top vetoes, then closes once allowed', async () => {
        let allowClose = false;
        modals.open({} as never, {});
        modals.open({} as never, {}, { beforeClose: () => allowClose });

        await modals.closeAll();
        expect(modals.count).toBe(2);

        allowClose = true;
        await modals.closeAll();
        expect(modals.count).toBe(0);
    });
});

describe('pending modal close', () => {
    it('does not close a newer modal while waiting for a close guard', async () => {
        await modals.closeAll();
        let allow!: (value: boolean) => void;
        const first = modals.open(
            {} as never,
            {},
            {
                beforeClose: () =>
                    new Promise((resolve) => {
                        allow = resolve;
                    }),
            },
        );
        const closing = modals.close();
        const next = modals.open({} as never, {});
        allow(true);
        await closing;
        expect(modals.stack.map((entry) => entry.id)).toEqual([next.id]);
        await first.closed;
        await modals.closeAll();
    });
});
