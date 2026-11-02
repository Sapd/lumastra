// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/livetv/admin/sources/[id]/index.ts — PUT (update).
 *
 * Security review 2026-09-13 deferred item 11: `sealCredential()` in
 * livetv-sources.queries.ts deliberately passes an already-sealed
 * (`enc:v1:`/`enc:v2:`) value through untouched — correct for a value read
 * back from the DB, wrong for one arriving over HTTP, where it lets a caller
 * plant a foreign envelope (bound to a different row/column) into this row's
 * `xtream_username`/`xtream_password` (the C19 transplant class). The PUT
 * boundary must reject a client-supplied credential that is already sealed,
 * using the shared `isSealed()` predicate.
 *
 * These tests drive the def through `mount()` — the real HTTP-facing seam —
 * rather than calling the handler or `sealCredential()` directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockGetSql } = vi.hoisted(() => ({ mockGetSql: vi.fn() }));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

const { mockGetSourceByIdWithCredentials, mockUpdateSource, mockDeleteSource } = vi.hoisted(() => ({
    mockGetSourceByIdWithCredentials: vi.fn(),
    mockUpdateSource: vi.fn(),
    mockDeleteSource: vi.fn(),
}));
vi.mock('$lib/server/database/queries/livetv-sources.queries.js', () => ({
    getSourceByIdWithCredentials: (...args: unknown[]) => mockGetSourceByIdWithCredentials(...args),
    updateSource: (...args: unknown[]) => mockUpdateSource(...args),
    updateRefreshStatus: vi.fn().mockResolvedValue(true),
    updateEpgRefreshStatus: vi.fn().mockResolvedValue(true),
    deleteSource: (...args: unknown[]) => mockDeleteSource(...args),
}));

const { mockValidateXtreamCredentials, mockValidateHdHomeRunDevice, mockBuildEpgUrl } = vi.hoisted(
    () => ({
        mockValidateXtreamCredentials: vi.fn(),
        mockValidateHdHomeRunDevice: vi.fn(),
        mockBuildEpgUrl: vi.fn((): string | undefined => 'http://provider.example/epg'),
    }),
);
vi.mock('$lib/server/services/livetv/index.js', () => ({
    validateXtreamCredentials: (...args: unknown[]) => mockValidateXtreamCredentials(...args),
    validateHdHomeRunDevice: mockValidateHdHomeRunDevice,
    buildEpgUrl: mockBuildEpgUrl,
    buildXtreamUrls: (creds: { serverUrl: string }) => ({
        m3uUrl: `${creds.serverUrl}/get.php`,
        xmltvUrl: `${creds.serverUrl}/xmltv.php`,
    }),
}));

const { mockValidateUrl } = vi.hoisted(() => ({ mockValidateUrl: vi.fn() }));
vi.mock('$lib/server/utils/url-validator.js', () => ({
    validateUrl: (...args: unknown[]) => mockValidateUrl(...args),
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

const { mockStartRun } = vi.hoisted(() => ({ mockStartRun: vi.fn() }));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({ orchestrator: { startRun: mockStartRun } }));

// ── Import after mocks ────────────────────────────────────────────────────────

import { mount } from '$lib/server/api/mount.js';
import { def } from './index.js';

const CTX_V1 = { surface: 'v1' as const };
const SOURCE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function makeEvent(body: unknown, sourceId = SOURCE_ID): RequestEvent {
    const url = `http://localhost/api/v1/livetv/admin/sources/${sourceId}`;
    return {
        url: new URL(url),
        request: new Request(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        params: { sourceId },
        route: { id: '/api/v1/livetv/admin/sources/[id]' as const },
        locals: { principal: { scopes: ['livetv:admin'] } },
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

describe('defs/livetv/admin/sources/[id] (PUT) — sealed credential rejection', () => {
    it('rejects an already-sealed xtreamPassword (enc:v2: envelope) with 422 validation_failed', async () => {
        const { PUT } = mount(def, CTX_V1);
        const event = makeEvent({ xtreamPassword: 'enc:v2:not-a-real-envelope-base64' });
        const res = await PUT!(event);

        expect(res.status).toBe(422);
        const body = await parseJson(res);
        expect(body.code).toBe('validation_failed');
        // Must not echo the submitted value back.
        expect(JSON.stringify(body)).not.toContain('not-a-real-envelope-base64');

        // Rejected at the boundary — never reached the DB.
        expect(mockGetSourceByIdWithCredentials).not.toHaveBeenCalled();
        expect(mockUpdateSource).not.toHaveBeenCalled();
    });

    it('rejects an already-sealed xtreamUsername (enc:v1: envelope) with 422 validation_failed', async () => {
        const { PUT } = mount(def, CTX_V1);
        const event = makeEvent({ xtreamUsername: 'enc:v1:not-a-real-envelope-base64' });
        const res = await PUT!(event);

        expect(res.status).toBe(422);
        const body = await parseJson(res);
        expect(body.code).toBe('validation_failed');
        expect(JSON.stringify(body)).not.toContain('not-a-real-envelope-base64');
        expect(mockUpdateSource).not.toHaveBeenCalled();
    });

    it('accepts a plaintext xtreamUsername/xtreamPassword and passes it through to updateSource', async () => {
        mockGetSourceByIdWithCredentials.mockResolvedValue({
            id: SOURCE_ID,
            name: 'Existing',
            source_type: 'm3u', // not 'xtream' — skips the xtream re-validation branch
            m3u_url: null,
            xmltv_url: null,
            xtream_server: null,
            xtream_username: null,
            xtream_password: null,
            hdhomerun_device_ip: null,
            hdhomerun_device_id: null,
            max_streams: 1,
            refresh_cron: null,
            last_refresh_at: null,
            last_refresh_status: null,
            last_refresh_summary: null,
            created_at: new Date(),
            updated_at: new Date(),
        });
        mockUpdateSource.mockResolvedValue({
            id: SOURCE_ID,
            name: 'Existing',
            source_type: 'm3u',
            max_streams: 1,
            refresh_cron: null,
            last_refresh_at: null,
            last_refresh_status: null,
            last_refresh_summary: null,
        });

        const { PUT } = mount(def, CTX_V1);
        const event = makeEvent({ xtreamUsername: 'plainUser', xtreamPassword: 'plainPass' });
        const res = await PUT!(event);

        expect(res.status).toBe(200);
        expect(mockUpdateSource).toHaveBeenCalledWith(
            {},
            SOURCE_ID,
            expect.objectContaining({
                xtream_username: 'plainUser',
                xtream_password: 'plainPass',
            }),
        );
    });
});

const existingSource = {
    id: SOURCE_ID,
    name: 'Existing',
    source_type: 'm3u',
    m3u_url: 'http://provider.example/old.m3u',
    xmltv_url: 'http://provider.example/old.xml',
    max_streams: 1,
    last_refresh_status: null,
    last_refresh_at: null,
    refresh_cron: null,
};
describe('setup edits take effect immediately', () => {
    beforeEach(() => {
        mockGetSourceByIdWithCredentials.mockResolvedValue(existingSource);
        mockUpdateSource.mockResolvedValue(existingSource);
        mockValidateUrl.mockResolvedValue({ valid: true });
        mockStartRun.mockResolvedValue({ runId: 'run-edit' });
    });
    it.each([
        [{ m3uUrl: 'http://provider.example/new.m3u' }, 'import-m3u', { m3u: 'run-edit' }],
        [{ xmltvUrl: 'http://provider.example/new.xml' }, 'import-epg', { epg: 'run-edit' }],
        [{ xtreamPassword: 'new-pass' }, 'import-m3u', { m3u: 'run-edit' }],
    ])('queues the changed feed and returns progress: %j', async (body, task, taskIds) => {
        if ('xtreamPassword' in body) {
            mockGetSourceByIdWithCredentials.mockResolvedValue({
                ...existingSource,
                source_type: 'xtream',
                xtream_server: 'http://provider.example',
                xtream_username: 'user',
                xtream_password: 'old-pass',
            });
            mockValidateXtreamCredentials.mockResolvedValue({ valid: true });
        }
        const res = await mount(def, CTX_V1).PUT!(makeEvent(body));
        expect(res.status).toBe(200);
        expect(mockStartRun).toHaveBeenCalledWith(
            task,
            { sourceId: SOURCE_ID },
            expect.any(Object),
        );
        expect((await parseJson(res)).taskIds).toEqual(taskIds);
    });
    it('reports enqueue failure and retries a failed playlist non-destructively on a subsequent save', async () => {
        mockStartRun.mockRejectedValueOnce(
            new Error('queue unavailable http://user:secret@queue.example'),
        );
        const res = await mount(def, CTX_V1).PUT!(
            makeEvent({ m3uUrl: 'http://provider.example/new.m3u' }),
        );
        expect(res.status).toBe(200);
        expect((await parseJson(res)).importError).toContain('save');
        expect(JSON.stringify(await parseJson(res))).not.toContain('secret');
        mockGetSourceByIdWithCredentials.mockResolvedValue({
            ...existingSource,
            last_refresh_status: 'failed',
        });
        mockStartRun.mockClear();
        await mount(def, CTX_V1).PUT!(makeEvent({ name: 'Existing' }));
        expect(mockStartRun).toHaveBeenCalledWith(
            'refresh-m3u',
            { sourceId: SOURCE_ID },
            expect.any(Object),
        );
    });
    it('retries only EPG on a plain edit after the guide failed', async () => {
        mockGetSourceByIdWithCredentials.mockResolvedValue({
            ...existingSource,
            last_refresh_status: 'success',
            last_refresh_summary: {
                channelCount: 25,
                epg: { status: 'failed', error: 'Guide unavailable' },
            },
        });
        const response = await mount(def, CTX_V1).PUT!(
            makeEvent({ name: 'Renamed', maxStreams: 2 }),
        );
        expect(response.status).toBe(200);
        expect(mockStartRun).toHaveBeenCalledWith(
            'import-epg',
            { sourceId: SOURCE_ID },
            expect.any(Object),
        );
        expect((await parseJson(response)).taskIds).toEqual({ epg: 'run-edit' });
    });
    it('validates, persists and imports an edited HDHomeRun device', async () => {
        mockGetSourceByIdWithCredentials.mockResolvedValue({
            ...existingSource,
            source_type: 'hdhomerun',
            hdhomerun_device_ip: '192.168.1.10',
        });
        mockValidateHdHomeRunDevice.mockResolvedValue({
            valid: true,
            deviceInfo: { deviceId: 'device-new', tunerCount: 4 },
        });
        const res = await mount(def, CTX_V1).PUT!(makeEvent({ hdHomeRunDeviceIp: '192.168.1.20' }));
        expect(res.status).toBe(200);
        expect(mockValidateHdHomeRunDevice).toHaveBeenCalledWith('192.168.1.20');
        expect(mockUpdateSource).toHaveBeenCalledWith(
            {},
            SOURCE_ID,
            expect.objectContaining({
                hdhomerun_device_ip: '192.168.1.20',
                hdhomerun_device_id: 'device-new',
                m3u_url: 'http://192.168.1.20/lineup.m3u',
            }),
        );
        expect(mockStartRun).toHaveBeenCalledWith(
            'import-m3u',
            { sourceId: SOURCE_ID },
            expect.any(Object),
        );
    });
    it('clears the previous device guide when the new HDHomeRun has no guide auth', async () => {
        mockGetSourceByIdWithCredentials.mockResolvedValue({
            ...existingSource,
            source_type: 'hdhomerun',
            hdhomerun_device_ip: '192.168.1.10',
        });
        mockValidateHdHomeRunDevice.mockResolvedValue({
            valid: true,
            deviceInfo: { deviceId: 'device-new', tunerCount: 2 },
        });
        mockBuildEpgUrl.mockReturnValueOnce(undefined);
        const res = await mount(def, CTX_V1).PUT!(makeEvent({ hdHomeRunDeviceIp: '192.168.1.20' }));
        expect(res.status).toBe(200);
        expect(mockUpdateSource).toHaveBeenCalledWith(
            {},
            SOURCE_ID,
            expect.objectContaining({ xmltv_url: null }),
        );
    });
    it.each([
        ['http://provider.example/old.xml', ''],
        [null, undefined],
    ])(
        'keeps XMLTV disabled while changing Xtream credentials (%s)',
        async (previousXmltv, xmltvUrl) => {
            mockGetSourceByIdWithCredentials.mockResolvedValue({
                ...existingSource,
                source_type: 'xtream',
                xtream_server: 'http://provider.example',
                xtream_username: 'user',
                xtream_password: 'old',
                xmltv_url: previousXmltv,
            });
            mockValidateXtreamCredentials.mockResolvedValue({ valid: true });
            const res = await mount(def, CTX_V1).PUT!(
                makeEvent({ xtreamPassword: 'new', xmltvUrl }),
            );
            expect(res.status).toBe(200);
            expect(mockUpdateSource).toHaveBeenCalledWith(
                {},
                SOURCE_ID,
                expect.objectContaining({ xmltv_url: null }),
            );
            expect(mockFetchSource.mock.calls.every((call) => call[1].contentLabel === 'M3U')).toBe(
                true,
            );
        },
    );
    it('does not reimport unchanged URLs or display-only edits', async () => {
        const res = await mount(def, CTX_V1).PUT!(
            makeEvent({ name: 'Renamed', m3uUrl: existingSource.m3u_url }),
        );
        expect(res.status).toBe(200);
        expect(mockStartRun).not.toHaveBeenCalled();
    });
    it('clears XMLTV with an explicit empty string, without fetching it', async () => {
        const res = await mount(def, CTX_V1).PUT!(makeEvent({ xmltvUrl: '' }));
        expect(res.status).toBe(200);
        expect(mockUpdateSource).toHaveBeenCalledWith(
            {},
            SOURCE_ID,
            expect.objectContaining({ xmltv_url: null }),
        );
        expect(mockFetchSource).not.toHaveBeenCalled();
        expect(mockStartRun).not.toHaveBeenCalled();
    });
    it.each(['garbage', '0 25 * * *', '*/0 * * * *', '0 0 1 * *'])(
        'rejects an unsupported refresh schedule: %s',
        async (refreshCron) => {
            const res = await mount(def, CTX_V1).PUT!(makeEvent({ refreshCron }));
            expect(res.status).toBe(422);
            expect(JSON.stringify(await parseJson(res))).toContain('0 */12 * * *');
            expect(mockUpdateSource).not.toHaveBeenCalled();
        },
    );
});
