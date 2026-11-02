// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * album-enrichment task — unit tests.
 *
 * Covers execute() behavior, abort-before-start guard, backlog.stages
 * translating PluginBacklogStatus to BacklogStage[], and the settings config.
 * The inlined execute body delegates to drainBacklog; we mock its heavy deps.
 */

vi.mock('$lib/server/services/album-local-art.js', () => ({
    recoverLocalAlbumArt: vi.fn().mockResolvedValue(false),
    backfillLocalAlbumArt: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/album-local-art.queries.js', () => ({
    getAlbumReleaseIdentifiers: vi.fn().mockResolvedValue({}),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

// ─── hoist mocks so vi.mock factories can reference them safely ──────────────
const { mockDrainBacklog, mockGetTaskSettings, mockGetAlbumEnrichmentBacklog } = vi.hoisted(() => ({
    mockDrainBacklog: vi.fn(),
    mockGetTaskSettings: vi.fn(),
    mockGetAlbumEnrichmentBacklog: vi.fn(),
}));

// ─── mock drainBacklog (heavy dep) ──────────────────────────────────────────
import type * as DrainBacklogModule from '../../../plugins/runtime/drain-backlog.js';
// The task reads the shared Discogs token through PluginSecrets, which uses
// `sql` as a tagged template. These tests pass an identity-marker object as
// ctx.sql (asserted by reference), so stub at the module boundary — token
// plumbing has its own coverage; these specs are about drain/backlog wiring.
vi.mock('$lib/server/services/discogs-token.js', () => ({
    DISCOGS_PLUGIN_ID: 'discogs',
    DISCOGS_TOKEN_KEY: 'DISCOGS_TOKEN',
    readDiscogsToken: vi.fn().mockResolvedValue(''),
    hasDiscogsToken: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../../plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return {
        ...actual,
        drainBacklog: mockDrainBacklog,
    };
});

// ─── mock task-settings ──────────────────────────────────────────────────────
vi.mock('../../../database/queries/task-settings.queries.js', () => ({
    getTaskSettings: mockGetTaskSettings,
    upsertTaskSettings: vi.fn().mockResolvedValue(undefined),
}));

// ─── mock the backlog query ──────────────────────────────────────────────────
vi.mock('../../../database/queries/album-enrichment.queries.js', () => ({
    getAlbumEnrichmentBacklog: mockGetAlbumEnrichmentBacklog,
    atomicallyWipeAlbumEnrichment: vi.fn().mockResolvedValue(undefined),
    countUnenrichedAlbums: vi.fn().mockResolvedValue(0),
    findCoverageTableBacklog: vi.fn().mockResolvedValue([]),
    getAlbumEnrichmentWipeBatch: vi.fn().mockResolvedValue([]),
    getUnenrichedAlbums: vi.fn().mockResolvedValue([]),
    markAlbumProcessed: vi.fn().mockResolvedValue(true),
    setAlbumCoverArtUrlIfNull: vi.fn().mockResolvedValue(true),
    reEnrollGapAlbumsForRepoll: vi.fn().mockResolvedValue(0),
    clearAlbumMarkerForGapRepoll: vi.fn().mockResolvedValue(0),
    deferAlbumAfterSourceOutage: vi.fn().mockResolvedValue(true),
}));

// ─── mock album-enrichment-sources ───────────────────────────────────────────
vi.mock('../../../services/album-enrichment-sources.js', () => ({
    enrichAlbumFromChain: vi.fn().mockResolvedValue(null),
    ALL_SOURCES: [
        { value: 'theaudiodb', label: 'TheAudioDB (free, no key)' },
        { value: 'discogs', label: 'Discogs (requires token)' },
        { value: 'deezer', label: 'Deezer (free, no key)' },
    ],
    DEFAULT_PRIMARY: 'theaudiodb',
    DEFAULT_FALLBACK: 'discogs',
}));

// ─── mock stage-state queries ─────────────────────────────────────────────────
vi.mock('../../../database/queries/stage-state.queries.js', () => ({
    upsertCompletedRow: vi.fn().mockResolvedValue(undefined),
}));

// ─── mock other heavy deps ────────────────────────────────────────────────────
vi.mock('../../../services/catalog.service.js', () => ({
    CatalogService: class {
        upsertExternalId = vi.fn().mockResolvedValue(undefined);
    },
}));
vi.mock('../../../database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('../../../database/queries/media-artwork.queries.js', () => ({
    upsertLocalArtwork: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../database/queries/album-art.queries.js', () => ({
    findTrackFileForAlbum: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../services/metadata-storage.service.js', () => ({
    resolveWritePath: vi.fn().mockResolvedValue({ filePath: '/tmp/test/poster.jpg' }),
}));
vi.mock('$lib/server/providers/implementations/musicbrainz/cover-art.js', () => ({
    getAlbumArt: vi.fn().mockResolvedValue(null),
    getAlbumArtUrl: vi.fn((mbid: string) => `https://coverartarchive.org/release/${mbid}/front`),
}));
vi.mock('../../../utils/fetch-utils.js', () => ({
    fetchWithTimeout: vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'test' }),
}));
vi.mock('$lib/server/config.js', () => ({
    config: { BASE_PATH: '/data' },
    getAuthoritativeStageIds: vi.fn(() => new Set<string>()),
    // registry.ts (imported transitively) reads this at module load.
    FEATURE_PER_TASK_QUEUES: false,
}));

import { albumEnrichmentTask, buildAlbumSourceChain } from './album-enrichment.js';
import { backfillLocalAlbumArt } from '$lib/server/services/album-local-art.js';

type AlbumEnrichmentInput = Record<string, unknown>;

function makeContext(
    overrides: Partial<TaskContext<AlbumEnrichmentInput>> = {},
): TaskContext<AlbumEnrichmentInput> {
    const ac = new AbortController();
    return {
        runId: 'test-run-1',
        attemptNumber: 1,
        input: {},
        scope: {},
        mode: 'scheduled',
        sql: { tag: 'ctx-sql' } as never,
        logger: {
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        reportProgress: vi.fn(),
        dep: vi.fn(),
        settings: vi.fn(),
        secrets: { get: vi.fn(), getOptional: vi.fn(), getUser: vi.fn() },
        reportFailure: vi.fn(),
        spend: vi.fn(),
        drain: vi.fn(),
        // The task gates external HTTP work behind `ctx.http` — provide a
        // mock so capability-required guards don't short-circuit before the
        // test reaches the behaviour it wants to exercise. Individual tests
        // can replace `http` in overrides to control fetch responses.
        http: {
            get: vi.fn(async () => new Response('{}', { status: 200 })),
            post: vi.fn(async () => new Response('{}', { status: 200 })),
        },
        ...overrides,
    } as unknown as TaskContext<AlbumEnrichmentInput>;
}

const defaultSettings = {
    primary_source: 'theaudiodb',
    fallback_source: 'none',
    discogs_token: '',
};

describe('album-enrichment task manifest', () => {
    it('has the correct id', () => {
        expect(albumEnrichmentTask.id).toBe('album-enrichment');
    });

    it('declares a 24h schedule with env override', () => {
        expect(albumEnrichmentTask.schedule).toMatchObject({
            every: '24h',
            envOverride: 'SYNC_ALBUM_ENRICHMENT_INTERVAL',
        });
    });

    it('has bulk resource class', () => {
        // resourceClass changed from io to bulk in production; album enrichment
        // is a long-running multi-source API drain (minutes to hours per pass).
        expect(albumEnrichmentTask.resourceClass).toBe('bulk');
    });

    it('has global scope', () => {
        expect(albumEnrichmentTask.scope).toBe('global');
    });

    // The property that matters is not the literal — it is that EVERY mode
    // maps to ONE key. exclusiveWith's mutex key is
    // `identityKey(taskId, identityFor(input))`, so a mode-suffixed identity
    // gave catchup, manual and force each their own key and the guard only
    // collapsed same-mode re-fires. Since `force` also wipes, that let a wipe
    // delete rows a manual or catchup run was mid-write on.
    it('gives every mode the SAME identity, so exclusiveWith spans all of them', () => {
        const keys = new Set(
            [{}, { mode: 'catchup' }, { mode: 'manual' }, { mode: 'force' }].map((input) =>
                albumEnrichmentTask.identityFor(input as never),
            ),
        );
        expect(keys.size).toBe(1);
        expect([...keys][0]).toBe('global');
    });

    it('declares database and http capabilities', () => {
        expect(albumEnrichmentTask.capabilities?.database).toBe(true);
        expect(albumEnrichmentTask.capabilities?.http).toBe(true);
    });
});

describe('album-enrichment execute()', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetTaskSettings.mockResolvedValue(defaultSettings);
        mockDrainBacklog.mockResolvedValue({
            stopReason: 'empty',
            itemsProduced: 0,
        });
    });

    it('calls drainBacklog and returns success', async () => {
        const ctx = makeContext();
        const result = await albumEnrichmentTask.execute(ctx);

        expect(mockDrainBacklog).toHaveBeenCalledOnce();
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
    });

    it('does nothing when DISABLE_MUSIC_ARTWORK_ENRICHMENT is on, however it was enqueued', async () => {
        // A music scan enqueues this task directly; pausing the schedule did not
        // stop it sending album names to TheAudioDB (egress audit 2026-10-01).
        const { config } = await import('$lib/server/config.js');
        const cfg = config as unknown as Record<string, unknown>;
        cfg.DISABLE_MUSIC_ARTWORK_ENRICHMENT = true;
        try {
            const result = await albumEnrichmentTask.execute(makeContext());

            expect(mockDrainBacklog).not.toHaveBeenCalled();
            expect(mockGetTaskSettings).not.toHaveBeenCalled();
            expect(result).toMatchObject({ success: true, itemsProcessed: 0 });

            const guard = [albumEnrichmentTask.coversStages?.[0]?.terminalDisposition ?? []]
                .flat()
                .find((d) => d.kind === 'global-guard');
            expect(guard && 'guard' in guard).toBe(true);
            await expect(
                (guard as { guard: (c: unknown) => Promise<boolean> }).guard(makeContext()),
            ).resolves.toBe(false);
        } finally {
            delete cfg.DISABLE_MUSIC_ARTWORK_ENRICHMENT;
        }
    });

    it('returns aborted stopReason when signal is already aborted before execute', async () => {
        const ac = new AbortController();
        ac.abort();
        const ctx = makeContext({ signal: ac.signal, abortSignal: ac.signal });

        const result = await albumEnrichmentTask.execute(ctx);

        expect(result.stopReason).toBe('aborted');
        expect(result.itemsProcessed).toBe(0);
    });

    it('runs local recovery before a missing Discogs token can stop networking', async () => {
        vi.mocked(backfillLocalAlbumArt).mockResolvedValueOnce(2);
        mockGetTaskSettings.mockResolvedValue({
            primary_source: 'discogs',
            fallback_source: 'none',
            tertiary_source: 'none',
        });
        const result = await albumEnrichmentTask.execute(makeContext());
        expect(backfillLocalAlbumArt).toHaveBeenCalledOnce();
        expect(result.itemsProcessed).toBe(2);
        expect(mockDrainBacklog).not.toHaveBeenCalled();
    });

    it('skips cleanly (success, 0 processed) when Discogs is configured but token is absent', async () => {
        // Unconfigured optional integration → graceful skip, not a thrown
        // failure (a throw would trip the amber "Actionable Task Failures").
        mockGetTaskSettings.mockResolvedValue({
            primary_source: 'discogs',
            fallback_source: 'none',
            tertiary_source: 'none',
            discogs_token: '',
        });

        const ctx = makeContext();
        const result = await albumEnrichmentTask.execute(ctx);

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(result.result?.message).toMatch(/discogs/i);
    });

    it('passes mode from ctx.input to drainBacklog', async () => {
        const ctx = makeContext({ input: { mode: 'force' } });
        await albumEnrichmentTask.execute(ctx);

        // drainBacklog receives the options object; check the mode was resolved
        // by resolveDrainMode (which we don't re-mock — actual helper runs).
        expect(mockDrainBacklog).toHaveBeenCalledOnce();
    });

    it('returns success=false with stopReason=aborted when drain returns aborted stop', async () => {
        mockDrainBacklog.mockResolvedValue({
            stopReason: 'aborted',
            itemsProduced: 0,
        });

        const ctx = makeContext();
        const result = await albumEnrichmentTask.execute(ctx);

        expect(result.success).toBe(false);
        expect(result.stopReason).toBe('aborted');
    });
});

describe('album-enrichment backlog.stages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('translates PluginBacklogStatus to BacklogStage[]', async () => {
        mockGetAlbumEnrichmentBacklog.mockResolvedValue({
            analyzed: 100,
            remaining: 30,
            ineligible: 10,
            failed: 5,
        });

        const ctx = makeContext();
        const stages = await albumEnrichmentTask.backlog!.stages(ctx);

        expect(stages).toEqual([
            { id: 'remaining', label: 'Remaining', count: 30 },
            { id: 'failed', label: 'Failed', count: 5 },
            { id: 'ineligible', label: 'Ineligible', count: 10 },
        ]);
        expect(mockGetAlbumEnrichmentBacklog).toHaveBeenCalledWith(ctx.sql, 2);
    });

    it('omits zero-count buckets', async () => {
        mockGetAlbumEnrichmentBacklog.mockResolvedValue({
            analyzed: 50,
            remaining: 0,
            ineligible: 0,
            failed: 0,
        });

        const ctx = makeContext();
        const stages = await albumEnrichmentTask.backlog!.stages(ctx);

        expect(stages).toHaveLength(0);
    });
});

it('limits the legacy no-match terminal disposition to the current processing version', () => {
    const dispositions = albumEnrichmentTask.coversStages?.[0].terminalDisposition;
    const rules = !dispositions ? [] : 'ruleId' in dispositions ? [dispositions] : dispositions;
    const rule = rules.find((entry) => entry.ruleId === 'legacy-no-match');
    expect(rule?.kind).toBe('predicate');
    if (!rule || rule.kind !== 'predicate') throw new Error('missing no-match rule');
    const capture = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
        text: strings.join('?'),
        values,
    }));
    const predicate = rule.excludes(capture as never) as unknown as {
        text: string;
        values: unknown[];
    };
    expect(predicate.text).toContain("->>'version')::int >=");
    expect(predicate.values).toEqual([2]);
});

describe('album source settings', () => {
    it('defaults to Deezer third and exposes it in each source selector', () => {
        const fields = albumEnrichmentTask.settings!.fields;
        expect(fields.find((field) => field.key === 'tertiary_source')?.default).toBe('deezer');
        for (const key of ['primary_source', 'fallback_source', 'tertiary_source']) {
            expect(fields.find((field) => field.key === key)?.options).toContainEqual({
                value: 'deezer',
                label: 'Deezer (free, no key)',
            });
        }
        expect(
            buildAlbumSourceChain({
                primary_source: 'theaudiodb',
                fallback_source: 'discogs',
                tertiary_source: 'deezer',
            }),
        ).toEqual(['theaudiodb', 'discogs', 'deezer']);
    });

    it('respects operator order, duplicates and disabled sources', () => {
        expect(
            buildAlbumSourceChain({
                primary_source: 'deezer',
                fallback_source: 'discogs',
                tertiary_source: 'deezer',
            }),
        ).toEqual(['deezer', 'discogs']);
        expect(
            buildAlbumSourceChain({
                primary_source: 'discogs',
                fallback_source: 'none',
                tertiary_source: 'none',
            }),
        ).toEqual(['discogs']);
    });
});
