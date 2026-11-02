// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Manifest regression lock for the five provider-artwork tasks.
 *
 * Every assertion here guards a SILENT degradation:
 *   - >1 coversStages entry  -> runner.ts:1963 logs a warning and skips the
 *     coverage wrapper; stage rows never terminate and re-enqueue every 60s.
 *   - global identityFor     -> stage-sweep.ts:685 enqueues one run with `{}`
 *     and the wrapper (which needs a string mediaItemId) never fires.
 *   - appliesTo 'tv'         -> the SDK spells it 'series'; 'tv' matches nothing.
 *   - factory-built manifest -> stage-applies-to-mirror-in-sync scrapes raw
 *     source with regexes; a computed manifest makes the lint validate nothing.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));
// Same reason as the registration test: keep @valkey/valkey-glide out of the
// unit-test process (artwork-rate-budget.ts is in the module graph).
vi.mock('../../../../cache/valkey.js', () => ({
    isValkeyReady: () => false,
    incr: vi.fn(),
    expire: vi.fn(),
    cacheGet: vi.fn(),
}));

import {
    providerArtworkPosterTask,
    providerArtworkBackdropTask,
    providerArtworkLogoTask,
    providerArtworkThumbTask,
    providerArtworkSeasonPosterTask,
} from '../provider-artwork-backfill.js';

const TASKS = [
    providerArtworkPosterTask,
    providerArtworkBackdropTask,
    providerArtworkLogoTask,
    providerArtworkThumbTask,
    providerArtworkSeasonPosterTask,
];

const EXPECTED_APPLIES_TO: Record<string, string[]> = {
    'provider-artwork-poster': ['movie', 'series', 'episode'],
    'provider-artwork-backdrop': ['movie', 'series', 'episode'],
    'provider-artwork-logo': ['movie', 'series'],
    'provider-artwork-thumb': ['episode'],
    'provider-artwork-season-poster': ['season'],
};

/**
 * The exact sentinel stage-sweep compares against (`stage-sweep.ts:631-648`).
 * It is DECLARED in `stage-state.service.ts:35` and re-exported through
 * stage-sweep's import list — copied here as a literal rather than imported so
 * this test does not drag the stage-state service's module graph in.
 */
const GLOBAL_IDENTITY_SENTINEL_UUID = '00000000-0000-0000-0000-000000000000';

const SOURCE_PATH = resolve(
    process.cwd(),
    'src/lib/server/tasks/builtin/native/provider-artwork-backfill.ts',
);

describe('provider-artwork task manifests', () => {
    it.each(TASKS.map((t) => [t.id, t] as const))(
        '%s declares EXACTLY ONE coversStages entry',
        (_id, task) => {
            expect(task.coversStages).toBeDefined();
            expect(task.coversStages).toHaveLength(1);
        },
    );

    it.each(TASKS.map((t) => [t.id, t] as const))(
        '%s names its stage the same as the task',
        (id, task) => {
            expect(task.coversStages?.[0].id).toBe(id);
        },
    );

    it.each(TASKS.map((t) => [t.id, t] as const))('%s uses appliesTo SDK spelling', (id, task) => {
        const appliesTo = [...(task.coversStages?.[0].appliesTo ?? [])];
        expect(appliesTo).toEqual(EXPECTED_APPLIES_TO[id]);
        expect(appliesTo).not.toContain('tv');
    });

    it.each(TASKS.map((t) => [t.id, t] as const))('%s is resourceClass bulk', (_id, task) => {
        expect(task.resourceClass).toBe('bulk');
    });

    it.each(TASKS.map((t) => [t.id, t] as const))(
        '%s has a PER-ITEM identity (stage-sweep must not classify it as global)',
        (_id, task) => {
            const idReal = task.identityFor({
                mediaItemId: '11111111-1111-4111-8111-111111111111',
            });
            const idSentinel = task.identityFor({ mediaItemId: GLOBAL_IDENTITY_SENTINEL_UUID });
            expect(idReal).not.toBe(idSentinel);
        },
    );

    it.each(TASKS.map((t) => [t.id, t] as const))(
        '%s accepts a mediaItemId and rejects input without one',
        (_id, task) => {
            expect(task.inputSchema.safeParse({ mediaItemId: 'abc' }).success).toBe(true);
            expect(task.inputSchema.safeParse({}).success).toBe(false);
        },
    );

    it.each(TASKS.map((t) => [t.id, t] as const))(
        '%s declares eligibility.sql (satisfies define-task.ts:123-141 for enqueueable)',
        (_id, task) => {
            expect(task.coversStages?.[0].enqueueable).toBe(true);
            expect(typeof task.coversStages?.[0].eligibility?.sql).toBe('function');
        },
    );

    it.each(TASKS.map((t) => [t.id, t] as const))(
        '%s declares NO exclusiveWith (a global SETNX would serialize the drain to one item)',
        (_id, task) => {
            expect(task.exclusiveWith).toBeUndefined();
        },
    );

    it.each(TASKS.map((t) => [t.id, t] as const))(
        '%s carries a SINGLE global-guard terminalDisposition (kill switch drains, never dead-letters)',
        (_id, task) => {
            const disposition = task.coversStages?.[0].terminalDisposition;
            expect(Array.isArray(disposition)).toBe(false);
            expect(disposition).toMatchObject({ kind: 'global-guard' });
            expect(
                (disposition as { retryAfterMs?: number } | undefined)?.retryAfterMs,
            ).toBeGreaterThan(0);
        },
    );

    it('lane A declares invalidatedBy; lane B (seasons) declares none', () => {
        for (const task of TASKS) {
            const invalidatedBy = task.coversStages?.[0].invalidatedBy;
            if (task.id === 'provider-artwork-season-poster') {
                expect(invalidatedBy).toBeUndefined();
            } else {
                expect([...(invalidatedBy ?? [])]).toEqual([
                    'metadata.changed',
                    'identity.changed',
                ]);
            }
        }
    });

    it('lane B backs off out to a 7-day ceiling (its only event-independent recovery rail)', () => {
        expect(providerArtworkSeasonPosterTask.coversStages?.[0].retryPolicy?.maxDelayMs).toBe(
            604_800_000,
        );
    });
});

describe('provider-artwork manifests are SOURCE LITERALS (mirror-lint visibility)', () => {
    const src = readFileSync(SOURCE_PATH, 'utf8');

    it('the appliesTo scraper finds all five stages', () => {
        // Verbatim copy of stage-applies-to-mirror-in-sync.js:62.
        const objRe = /\{\s*id:\s*['"]([a-z0-9-]+)['"][^}]*?appliesTo:\s*\[([^\]]*)\]/g;
        const found = [...src.matchAll(objRe)].map((m) => m[1]);
        expect(found.sort()).toEqual(Object.keys(EXPECTED_APPLIES_TO).sort());
    });

    it('the resourceClass scraper pairs all five stages with bulk', () => {
        // Verbatim copy of stage-applies-to-mirror-in-sync.js:101-102.
        const taskRe =
            /resourceClass:\s*['"]([a-z]+)['"][\s\S]{0,4000}?coversStages:\s*\[([\s\S]*?)\]\s*,/g;
        const pairs: Array<[string, string]> = [];
        for (const m of src.matchAll(taskRe)) {
            for (const sm of m[2].matchAll(/\bid:\s*['"]([a-z0-9-]+)['"]/g)) {
                pairs.push([sm[1], m[1]]);
            }
        }
        expect(pairs.sort()).toEqual(
            Object.keys(EXPECTED_APPLIES_TO)
                .sort()
                .map((id) => [id, 'bulk']),
        );
    });
});
