// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/livetv/admin/sources/index.ts — POST (create).
 *
 * Security review 2026-09-13 deferred item 11 — see the sibling
 * `[id]/index.test.ts` header for the full rationale. This file covers the
 * create boundary: a client-supplied `xtreamUsername`/`xtreamPassword` that
 * is already sealed (`enc:v1:`/`enc:v2:`) must be rejected before it reaches
 * `createSource`, driven through `mount()` (the real HTTP-facing seam).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockGetSql } = vi.hoisted(() => ({ mockGetSql: vi.fn() }));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

const { mockCreateSource, mockGetAllSourcesWithChannelCounts } = vi.hoisted(() => ({
    mockCreateSource: vi.fn(),
    mockGetAllSourcesWithChannelCounts: vi.fn(),
}));
vi.mock('$lib/server/database/queries/livetv-sources.queries.js', () => ({
    createSource: (...args: unknown[]) => mockCreateSource(...args),
    updateRefreshStatus: vi.fn().mockResolvedValue(true),
    getAllSourcesWithChannelCounts: (...args: unknown[]) =>
        mockGetAllSourcesWithChannelCounts(...args),
}));

const { mockValidateXtreamCredentials, mockValidateHdHomeRunDevice } = vi.hoisted(() => ({
    mockValidateXtreamCredentials: vi.fn(),
    mockValidateHdHomeRunDevice: vi.fn(),
}));
vi.mock('$lib/server/services/livetv/index.js', () => ({
    validateXtreamCredentials: (...args: unknown[]) => mockValidateXtreamCredentials(...args),
    validateHdHomeRunDevice: (...args: unknown[]) => mockValidateHdHomeRunDevice(...args),
    buildXtreamUrls: (creds: { serverUrl: string }) => ({
        m3uUrl: `${creds.serverUrl}/get.php`,
        xmltvUrl: `${creds.serverUrl}/xmltv.php`,
    }),
    buildEpgUrl: () => undefined,
}));

const { mockValidateUrl } = vi.hoisted(() => ({ mockValidateUrl: vi.fn() }));
vi.mock('$lib/server/utils/url-validator.js', () => ({
    validateUrl: (...args: unknown[]) => mockValidateUrl(...args),
}));

const { mockStartRun } = vi.hoisted(() => ({ mockStartRun: vi.fn() }));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: (...args: unknown[]) => mockStartRun(...args) },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: { ...actual.config, LIVETV_ALLOW_PRIVATE_URLS: false },
    };
});

const { mockFetchSource } = vi.hoisted(() => ({ mockFetchSource: vi.fn() }));
vi.mock('$lib/server/services/livetv/fetch-source.js', () => ({
    fetchSsrfValidatedText: mockFetchSource,
    M3U_MAX_FETCH_BYTES: 268435456,
    XMLTV_MAX_FETCH_BYTES: 104857600,
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { mount } from '$lib/server/api/mount.js';
import { def } from './index.js';

const CTX_V1 = { surface: 'v1' as const };

function makeEvent(body: unknown): RequestEvent {
    const url = 'http://localhost/api/v1/livetv/admin/sources';
    return {
        url: new URL(url),
        request: new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        params: {},
        route: { id: '/api/v1/livetv/admin/sources' as const },
        locals: {
            principal: { scopes: ['livetv:admin'] },
            user: { username: 'admin', hasLiveTvPermission: true },
        },
        cookies: { get: vi.fn(), set: vi.fn() } as unknown as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

async function parseJson(res: Response) {
    return res.clone().json() as Promise<Record<string, unknown>>;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetSql.mockResolvedValue({});
    mockFetchSource.mockImplementation(async (_url: string, opts: { contentLabel: string }) =>
        opts.contentLabel === 'M3U' ? '#EXTM3U\n' : '<tv></tv>',
    );
});

describe('defs/livetv/admin/sources (POST) — sealed credential rejection', () => {
    it('rejects an already-sealed xtreamPassword (enc:v2: envelope) with 422 validation_failed', async () => {
        const { POST } = mount(def, CTX_V1);
        const event = makeEvent({
            name: 'Test Source',
            sourceType: 'xtream',
            xtreamServer: 'http://provider.example',
            xtreamUsername: 'plainUser',
            xtreamPassword: 'enc:v2:not-a-real-envelope-base64',
        });
        const res = await POST!(event);

        expect(res.status).toBe(422);
        const body = await parseJson(res);
        expect(body.code).toBe('validation_failed');
        expect(JSON.stringify(body)).not.toContain('not-a-real-envelope-base64');

        // Rejected at the boundary — never reached credential validation or the DB.
        expect(mockValidateXtreamCredentials).not.toHaveBeenCalled();
        expect(mockCreateSource).not.toHaveBeenCalled();
    });

    it('rejects an already-sealed xtreamUsername (enc:v1: envelope) with 422 validation_failed', async () => {
        const { POST } = mount(def, CTX_V1);
        const event = makeEvent({
            name: 'Test Source',
            sourceType: 'xtream',
            xtreamServer: 'http://provider.example',
            xtreamUsername: 'enc:v1:not-a-real-envelope-base64',
            xtreamPassword: 'plainPass',
        });
        const res = await POST!(event);

        expect(res.status).toBe(422);
        const body = await parseJson(res);
        expect(body.code).toBe('validation_failed');
        expect(JSON.stringify(body)).not.toContain('not-a-real-envelope-base64');
        expect(mockValidateXtreamCredentials).not.toHaveBeenCalled();
        expect(mockCreateSource).not.toHaveBeenCalled();
    });

    it('accepts a plaintext xtreamUsername and passes it through to createSource', async () => {
        mockValidateUrl.mockResolvedValue({ valid: true, resolvedUrl: 'http://192.0.2.10/x.m3u' });
        mockCreateSource.mockResolvedValue({
            id: 'src-new',
            name: 'Test Source',
            source_type: 'm3u',
            max_streams: 1,
            refresh_cron: '0 */12 * * *',
            last_refresh_at: null,
            last_refresh_status: null,
            last_refresh_summary: null,
        });

        const { POST } = mount(def, CTX_V1);
        const event = makeEvent({
            name: 'Test Source',
            sourceType: 'm3u',
            m3uUrl: 'http://192.0.2.10/x.m3u',
            // Irrelevant to an m3u source but schema-permitted — proves a
            // plaintext value in these fields is never blocked.
            xtreamUsername: 'plainUser',
        });
        const res = await POST!(event);

        expect(res.status).toBe(201);
        expect(mockCreateSource).toHaveBeenCalledWith(
            {},
            expect.objectContaining({ xtream_username: 'plainUser' }),
        );
    });
});

describe('defs/livetv/admin/sources (POST) — initial import', () => {
    it('starts only import-m3u; that run starts the EPG import once the channels exist', async () => {
        mockValidateUrl.mockImplementation(async (url: string) => ({
            valid: true,
            resolvedUrl: url,
        }));
        mockCreateSource.mockResolvedValue({
            id: 'src-new',
            name: 'Big Provider',
            source_type: 'm3u',
            max_streams: 1,
            refresh_cron: '0 */12 * * *',
            last_refresh_at: null,
            last_refresh_status: null,
            last_refresh_summary: null,
        });
        mockStartRun.mockResolvedValue({ runId: 'run-m3u' });

        const { POST } = mount(def, CTX_V1);
        const res = await POST!(
            makeEvent({
                name: 'Big Provider',
                sourceType: 'm3u',
                m3uUrl: 'http://192.0.2.10/get.php?type=m3u_plus',
                xmltvUrl: 'http://192.0.2.10/xmltv.php',
            }),
        );

        expect(res.status).toBe(201);
        // Starting import-epg here as well raced the M3U import's channel rewrite.
        expect(mockStartRun).toHaveBeenCalledTimes(1);
        expect(mockStartRun.mock.calls[0][0]).toBe('import-m3u');
        expect((await parseJson(res)).taskIds).toEqual({ m3u: 'run-m3u' });
    });
});

describe('first-time feed validation and provider defaults', () => {
    beforeEach(() => {
        mockValidateUrl.mockResolvedValue({ valid: true });
        mockCreateSource.mockResolvedValue({
            id: 'new',
            name: 'Provider',
            source_type: 'm3u',
            max_streams: 1,
        });
        mockStartRun.mockResolvedValue({ runId: 'run-new' });
    });
    it.each([
        ['M3U', '<html>login secret-key</html>', undefined],
        ['XMLTV', '#EXTM3U', 'http://provider.example/epg'],
    ])('rejects a non-%s feed before persisting', async (label, content, xmltvUrl) => {
        mockFetchSource.mockImplementation(async (_url: string, opts: { contentLabel: string }) =>
            opts.contentLabel === label ? content : '#EXTM3U',
        );
        const res = await mount(def, CTX_V1).POST!(
            makeEvent({
                name: 'Provider',
                sourceType: 'm3u',
                m3uUrl: 'http://user:secret@provider.example/list',
                xmltvUrl,
            }),
        );
        expect(res.status).toBe(422);
        const text = JSON.stringify(await parseJson(res));
        expect(text).toContain(label);
        expect(text).not.toContain('secret');
        expect(mockCreateSource).not.toHaveBeenCalled();
    });
    it('reports an initial enqueue failure with a safe retry instruction', async () => {
        mockStartRun.mockRejectedValueOnce(
            new Error('queue unavailable http://user:secret@queue.example'),
        );
        const res = await mount(def, CTX_V1).POST!(
            makeEvent({
                name: 'Provider',
                sourceType: 'm3u',
                m3uUrl: 'http://provider.example/list',
            }),
        );
        expect(res.status).toBe(201);
        expect((await parseJson(res)).importError).toContain('save');
        expect(JSON.stringify(await parseJson(res))).not.toContain('secret');
    });
    it('uses the provider connection limit without requiring a separate test click', async () => {
        mockValidateXtreamCredentials.mockResolvedValue({
            valid: true,
            serverInfo: { maxConnections: 4 },
        });
        const res = await mount(def, CTX_V1).POST!(
            makeEvent({
                name: 'Provider',
                sourceType: 'xtream',
                xtreamServer: 'http://provider.example',
                xtreamUsername: 'user',
                xtreamPassword: 'pass',
            }),
        );
        expect(res.status).toBe(201);
        expect(mockCreateSource).toHaveBeenCalledWith(
            {},
            expect.objectContaining({ max_streams: 4 }),
        );
    });
    it('keeps an explicit operator stream limit', async () => {
        mockValidateXtreamCredentials.mockResolvedValue({
            valid: true,
            serverInfo: { maxConnections: 4 },
        });
        const res = await mount(def, CTX_V1).POST!(
            makeEvent({
                name: 'Provider',
                sourceType: 'xtream',
                xtreamServer: 'http://provider.example',
                xtreamUsername: 'user',
                xtreamPassword: 'pass',
                maxStreams: 2,
            }),
        );
        expect(res.status).toBe(201);
        expect(mockCreateSource).toHaveBeenCalledWith(
            {},
            expect.objectContaining({ max_streams: 2 }),
        );
    });
});
