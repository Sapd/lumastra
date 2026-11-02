// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * End-to-end for drop-in plugins: discovery → load → REAL registry → behaviour.
 *
 * The companion `sample-plugins.test.ts` mocks the registry, so it proves the
 * loader calls `registerX` with the right id and kind — and nothing more. Three
 * things it cannot see, all of which have already produced defects here:
 *
 *  1. the REAL registry's own validation. `validateAt('startup')` is what
 *     rejected a task whose `processingVersion` the SDK had waved through, and
 *     a stubbed `registerTask` accepts anything.
 *  2. cross-contract id collisions, which the per-type Maps do not catch and
 *     `assertIdAvailable` does.
 *  3. whether a loaded plugin actually DOES anything. Registration is not
 *     behaviour; every sample here is executed through the host's real dispatch
 *     path, not called directly.
 *
 * The registry is a process-global singleton with no reset and duplicate-id
 * rejection, so everything loads exactly once in `beforeAll`. Vitest isolates
 * test files, so this file gets a clean registry of its own.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The one thing that must be faked: `discoverExternalPlugins` asks the database
// whether each directory has a registry row. None do — they are drop-ins, which
// is the path under test.
vi.mock('../../database/queries/external-plugins.queries.js', () => ({
    getExternalPlugin: vi.fn(async () => null),
    listLoadableExternalPlugins: vi.fn(async () => []),
}));

vi.mock('../../database/queries/metadata-aggregation.queries.js', () => ({
    setEffectiveFieldPriorities: vi.fn(),
}));

import { registry } from '$lib/server/tasks/registry.js';
import { discoverExternalPlugins, loadExternalPlugin } from './loader.js';

const EXAMPLES = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../examples/plugins',
);

const sql = {} as never;
let discovered: string[] = [];

beforeAll(async () => {
    process.env.PLUGINS_ENABLED = 'true';
    process.env.PLUGINS_EXTERNAL_DIR = EXAMPLES;
    // The real discovery walk, over the real examples directory.
    discovered = await discoverExternalPlugins(sql);
    for (const dir of discovered) await loadExternalPlugin(dir);
});

/** A context sufficient for a sample to run. Samples touch only the logger. */
const ctx = () =>
    ({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        signal: new AbortController().signal,
    }) as never;

describe('discovery finds every sample as a drop-in', () => {
    it('discovers all of them', () => {
        const names = discovered.map((d) => path.basename(d)).sort();
        const onDisk = fs
            .readdirSync(EXAMPLES, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort();
        expect(names).toEqual(onDisk);
    });
});

describe('the REAL registry accepted them', () => {
    it.each([
        ['sample-task', () => registry.getTask('sample-task')],
        ['sample-provider', () => registry.getProvider('sample-provider')],
        ['sample-trickplay', () => registry.getTrickplay('sample-trickplay')],
        ['sample-watch-sync', () => registry.getWatchSync('sample-watch-sync')],
        ['sample-feature', () => registry.getFeature('sample-feature')],
        ['sample-integration', () => registry.getIntegration('sample-integration')],
        ['sample-media-source', () => registry.getMediaSource('sample-media-source')],
        ['sample-external-service', () => registry.getExternalService('sample-external-service')],
        [
            'sample-subtitle-provider',
            () => registry.getSubtitleProvider('sample-subtitle-provider'),
        ],
        ['sample-lyrics-ts', () => registry.getLyricsProvider('sample-lyrics-ts')],
        ['sample-auth-provider', () => registry.getAuthProvider('sample-auth-provider')],
    ])('%s is registered under its own contract kind', (_name, get) => {
        expect(get()).toBeDefined();
    });

    it('passes the registry’s OWN startup validation', () => {
        // The gate a mocked registerTask cannot express. This is what caught a
        // task the SDK validator had accepted.
        expect(() => registry.validateAt('startup')).not.toThrow();
    });

    it('registered the aggregate’s anchor and its namespaced sibling', () => {
        expect(registry.getFeature('sample-bundle')).toBeDefined();
        expect(registry.getTask('sample-bundle-cleanup')).toBeDefined();
    });

    it('registered the media source’s PAIRED task — without it nothing scans', () => {
        expect(registry.getTask('sample-media-source-scan')).toBeDefined();
    });
});

describe('they actually run', () => {
    it('the task executes and reports success', async () => {
        const def = registry.getTask('sample-task');
        const result = await def?.execute?.(ctx());
        expect(result).toMatchObject({ success: true });
    });

    it('the feature’s route handler answers', async () => {
        const route = registry.getFeature('sample-feature')?.routes?.[0];
        expect(route?.method).toBe('GET');
        // The real signature: (ctx, req, params). Calling it the way the host
        // does is the point — a one-arg call would pass here and fail in
        // production the moment the handler read its request.
        const res = (await route?.handler?.(
            ctx(),
            new Request('https://host/api/plugins/sample-feature/ping'),
            {},
        )) as Response;
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toMatchObject({ from: 'sample-feature' });
    });

    it('the metadata provider returns a detail record', async () => {
        const def = registry.getProvider('sample-provider');
        await expect(def?.detail?.(ctx(), 'sample-1')).resolves.toMatchObject({
            providerId: 'sample-1',
        });
    });

    it('the trickplay provider returns geometry', async () => {
        const def = registry.getTrickplay('sample-trickplay');
        await expect(def?.fetchParams?.(ctx(), {} as never)).resolves.toMatchObject({
            columns: 10,
        });
    });

    it('the watch-sync pushes — the engine calls this directly, no paired task', async () => {
        const def = registry.getWatchSync('sample-watch-sync');
        await expect(def?.pushWatchState?.(ctx(), {} as never)).resolves.toMatchObject({
            processed: 0,
        });
    });

    it('the media source scans when its OWN task drives it', async () => {
        const task = registry.getTask('sample-media-source-scan');
        await expect(task?.execute?.(ctx())).resolves.toMatchObject({ success: true });
    });

    it('the integration handles a webhook', async () => {
        const def = registry.getIntegration('sample-integration');
        await expect(def?.handleWebhook?.(ctx(), { hello: true })).resolves.toMatchObject({
            ok: true,
        });
    });

    it('the auth provider accepts the right password and refuses the wrong one', async () => {
        const def = registry.getAuthProvider('sample-auth-provider');
        await expect(
            def?.verifyCredentials?.(ctx(), {
                username: 'alice',
                password: 'correct-horse',
                clientIp: '1.2.3.4',
            }),
        ).resolves.toMatchObject({ ok: true, identity: { subject: 'sample-uid-alice' } });
        await expect(
            def?.verifyCredentials?.(ctx(), {
                username: 'alice',
                password: 'wrong',
                clientIp: '1.2.3.4',
            }),
        ).resolves.toMatchObject({ ok: false, reason: 'invalid_credentials' });
    });
});

describe('through the host’s real dispatch paths, not called directly', () => {
    it('lyrics reach the player via fetchLyricsFromPlugins', async () => {
        const { fetchLyricsFromPlugins } = await import('./lyrics-providers.js');
        const out = await fetchLyricsFromPlugins({
            trackId: '11111111-1111-1111-1111-111111111111',
            title: 'Song',
            artist: 'Artist',
            album: 'Album',
            durationSeconds: 100,
        });
        expect(out).toMatchObject({ providerId: 'sample-lyrics-ts' });
        expect(out?.plainLyrics).toContain('Song');
    });

    it('subtitle candidates come back host-RANKED, viewer language first', async () => {
        const { searchSubtitleCandidates } =
            await import('$lib/server/services/subtitle-acquisition.service.js');
        const candidates = await searchSubtitleCandidates({
            mediaItemId: '11111111-1111-1111-1111-111111111111',
            mediaType: 'movie',
            title: 'A Film',
            languages: ['de', 'en'],
        });
        expect(candidates.length).toBeGreaterThan(0);
        // The sample returns one per requested language; the host orders them
        // by the viewer's preference, so 'de' must lead.
        expect(candidates[0].language).toBe('de');
        expect(candidates.every((c) => c.providerId === 'sample-subtitle-provider')).toBe(true);
    });
});
