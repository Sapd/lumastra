// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — plugin-contributed home sections.
 *
 * The load-bearing property is that a plugin hands over IDS and the host
 * decides visibility. A plugin cannot surface media the viewer's library scope
 * or age rating hides, no matter what it returns — that check is not something
 * a plugin opts into, it is something it cannot opt out of.
 */

import { describe, it, expect, vi } from 'vitest';
import type { FeatureDefinition, PluginContext } from '@sapd/lumastra-plugin-sdk';
import { collectPluginHomeSections } from './home-sections.js';

const ctxStub = { logger: { warn: vi.fn() } } as unknown as PluginContext;

function feature(id: string, homeSections?: () => Promise<unknown>): FeatureDefinition {
    return { id, routes: [], ...(homeSections ? { homeSections } : {}) } as FeatureDefinition;
}

/** Stands in for the host's viewer-scoped resolution. */
const allowAll = async (ids: string[]) =>
    ids.map((id) => ({ id, mediaType: 'movie', title: `Item ${id}`, allowed: true }));

function deps(
    features: FeatureDefinition[],
    resolve: (
        ids: string[],
    ) => Promise<
        Array<{ id: string; mediaType: string; title?: string; allowed: boolean }>
    > = allowAll,
) {
    return { listFeatures: () => features, buildCtx: () => ctxStub, resolveForViewer: resolve };
}

describe('collectPluginHomeSections', () => {
    it('turns a contribution into a section of resolved items', async () => {
        const out = await collectPluginHomeSections(
            deps([
                feature('recs', async () => [
                    { id: 'staff-picks', title: 'Staff Picks', mediaItemIds: ['a', 'b'] },
                ]),
            ]),
        );

        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('plugin:recs:staff-picks');
        expect(out[0].title).toBe('Staff Picks');
        expect(out[0].items).toHaveLength(2);
    });

    it('DROPS items the viewer may not see', async () => {
        // The whole reason a plugin returns ids rather than items: it never
        // gets to decide what this viewer is allowed to be shown.
        const out = await collectPluginHomeSections(
            deps(
                [
                    feature('leaky', async () => [
                        { id: 's', title: 'S', mediaItemIds: ['visible', 'hidden'] },
                    ]),
                ],
                async (ids) =>
                    ids.map((id) => ({
                        id,
                        mediaType: 'movie',
                        allowed: id === 'visible',
                    })),
            ),
        );

        expect(out[0].items.map((i) => i.id)).toEqual(['visible']);
    });

    it('drops a section whose every item the viewer may not see', async () => {
        // An empty rail is worse than no rail: it reads as a broken feature.
        const out = await collectPluginHomeSections(
            deps(
                [feature('all-hidden', async () => [{ id: 's', title: 'S', mediaItemIds: ['x'] }])],
                async (ids) => ids.map((id) => ({ id, mediaType: 'movie', allowed: false })),
            ),
        );

        expect(out).toEqual([]);
    });

    it('keeps other features when one throws', async () => {
        const out = await collectPluginHomeSections(
            deps([
                feature('broken', async () => {
                    throw new Error('boom');
                }),
                feature('fine', async () => [{ id: 's', title: 'Fine', mediaItemIds: ['a'] }]),
            ]),
        );

        expect(out.map((s) => s.title)).toEqual(['Fine']);
    });

    it('ignores a contribution that is not shaped like one', async () => {
        const out = await collectPluginHomeSections(
            deps([
                feature('sloppy', async () => [
                    { id: 'no-title', mediaItemIds: ['a'] },
                    { title: 'no id', mediaItemIds: ['a'] },
                    { id: 'ok', title: 'OK', mediaItemIds: ['a'] },
                ]),
            ]),
        );

        expect(out.map((s) => s.title)).toEqual(['OK']);
    });

    it('abandons a feature that overruns its budget', async () => {
        vi.useFakeTimers();
        try {
            const pending = collectPluginHomeSections(
                deps([
                    feature('slow', () => new Promise(() => {})),
                    feature('quick', async () => [
                        { id: 's', title: 'Quick', mediaItemIds: ['a'] },
                    ]),
                ]),
            );
            await vi.advanceTimersByTimeAsync(5000);

            expect((await pending).map((s) => s.title)).toEqual(['Quick']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('never rejects, so the home page cannot fail because of a plugin', async () => {
        await expect(
            collectPluginHomeSections(
                deps([
                    feature('broken', async () => {
                        throw new Error('boom');
                    }),
                ]),
            ),
        ).resolves.toEqual([]);
    });
});
