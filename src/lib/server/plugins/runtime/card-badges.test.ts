// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — plugin-contributed badges on media cards.
 *
 * This runs on the hottest read path in the app, fanning out to third-party
 * code, so the tests are mostly about what it refuses to let a plugin do:
 * exceed its budget, return junk, flood a card, or take the row down with it.
 */

import { describe, it, expect, vi } from 'vitest';
import type { FeatureDefinition, PluginContext } from '@sapd/lumastra-plugin-sdk';
import { collectPluginBadges, MAX_BADGES_PER_ITEM } from './card-badges.js';

const ctxStub = { logger: { warn: vi.fn() } } as unknown as PluginContext;

function feature(
    id: string,
    decorateCards?: (
        ctx: PluginContext,
        refs: { mediaItemId: string; mediaType: string }[],
    ) => Promise<unknown>,
): FeatureDefinition {
    return { id, routes: [], ...(decorateCards ? { decorateCards } : {}) } as FeatureDefinition;
}

function deps(features: FeatureDefinition[]) {
    return { listFeatures: () => features, buildCtx: () => ctxStub };
}

const REFS = [
    { mediaItemId: 'a', mediaType: 'movie' },
    { mediaItemId: 'b', mediaType: 'series' },
];

const badge = (text: string) => ({ text, color: 'primary' as const });

describe('collectPluginBadges', () => {
    it('returns nothing when no feature decorates', async () => {
        const out = await collectPluginBadges(REFS, deps([feature('plain')]));
        expect(out.size).toBe(0);
    });

    it('merges badges from several features onto the same item', async () => {
        const out = await collectPluginBadges(
            REFS,
            deps([
                feature('alpha', async () => ({ a: [badge('4K')] })),
                feature('beta', async () => ({ a: [badge('HDR')] })),
            ]),
        );

        expect(
            out
                .get('a')
                ?.map((b) => b.text)
                .sort(),
        ).toEqual(['4K', 'HDR']);
    });

    it('ignores ids the host never asked about', async () => {
        // A plugin returning badges for items that are not on screen is either
        // confused or probing; either way the host asked about a specific set.
        const out = await collectPluginBadges(
            REFS,
            deps([feature('nosy', async () => ({ a: [badge('ok')], zzz: [badge('nope')] }))]),
        );

        expect([...out.keys()]).toEqual(['a']);
    });

    it('caps how many badges one item can collect', async () => {
        const many = Array.from({ length: 20 }, (_, i) => badge(`b${i}`));
        const out = await collectPluginBadges(
            REFS,
            deps([feature('flood', async () => ({ a: many }))]),
        );

        expect(out.get('a')?.length).toBe(MAX_BADGES_PER_ITEM);
    });

    it('drops malformed badges but keeps the good ones beside them', async () => {
        const out = await collectPluginBadges(
            REFS,
            deps([
                feature('sloppy', async () => ({
                    a: [{ color: 'primary' }, badge('good'), { text: 'no colour' }, 'nope'],
                })),
            ]),
        );

        expect(out.get('a')?.map((b) => b.text)).toEqual(['good']);
    });

    it('keeps other features when one throws', async () => {
        const out = await collectPluginBadges(
            REFS,
            deps([
                feature('broken', async () => {
                    throw new Error('boom');
                }),
                feature('working', async () => ({ b: [badge('fine')] })),
            ]),
        );

        expect(out.get('b')?.map((b) => b.text)).toEqual(['fine']);
    });

    it('never rejects, so a card row cannot fail because of a plugin', async () => {
        await expect(
            collectPluginBadges(
                REFS,
                deps([
                    feature('broken', async () => {
                        throw new Error('boom');
                    }),
                ]),
            ),
        ).resolves.toBeInstanceOf(Map);
    });

    it('abandons a feature that overruns the budget', async () => {
        vi.useFakeTimers();
        try {
            const pending = collectPluginBadges(
                REFS,
                deps([
                    feature('slow', () => new Promise(() => {})),
                    feature('fast', async () => ({ a: [badge('quick')] })),
                ]),
            );
            await vi.advanceTimersByTimeAsync(1000);
            const out = await pending;

            // The fast one still contributed; the slow one simply did not.
            expect(out.get('a')?.map((b) => b.text)).toEqual(['quick']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not call plugins at all for an empty ref list', async () => {
        const decorate = vi.fn(async () => ({}));
        const out = await collectPluginBadges([], deps([feature('any', decorate)]));

        expect(decorate).not.toHaveBeenCalled();
        expect(out.size).toBe(0);
    });
});
