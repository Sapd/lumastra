// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the admin diagnostics API defs:
 *  - defs/admin/diagnostics/index.ts        (GET list, DELETE filtered clear)
 *  - defs/admin/diagnostics/[id]/index.ts   (GET detail, DELETE one)
 *  - defs/admin/diagnostics/[id]/blob.ts    (GET blob, gzip|text)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import type { ClientDiagnosticRow } from '$lib/server/database/queries/client-diagnostics.queries.js';
import { gzipSync } from 'node:zlib';

const mockGetDb = vi.fn();
const mockListClientDiagnostics = vi.fn();
const mockGetClientDiagnosticById = vi.fn();
const mockGetLogBundleBlob = vi.fn();
const mockDeleteClientDiagnosticById = vi.fn();
const mockDeleteClientDiagnostics = vi.fn();
const mockAuditLog = vi.fn();
const mockAuditActor = vi.fn((..._args: unknown[]) => ({ username: 'admin1' }));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/client-diagnostics.queries.js', () => ({
    listClientDiagnostics: (...args: unknown[]) => mockListClientDiagnostics(...args),
    getClientDiagnosticById: (...args: unknown[]) => mockGetClientDiagnosticById(...args),
    getLogBundleBlob: (...args: unknown[]) => mockGetLogBundleBlob(...args),
    deleteClientDiagnosticById: (...args: unknown[]) => mockDeleteClientDiagnosticById(...args),
    deleteClientDiagnostics: (...args: unknown[]) => mockDeleteClientDiagnostics(...args),
}));

vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: (...args: unknown[]) => mockAuditLog(...args),
    auditActor: (...args: unknown[]) => mockAuditActor(...args),
}));

vi.mock('$lib/server/crypto/master-key.js', () => ({ resolveMasterKey: () => undefined }));

const mockLogWarn = vi.fn();
vi.mock('$lib/server/utils/logger.js', () => {
    const l = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: (...a: unknown[]) => mockLogWarn(...a),
        error: vi.fn(),
    };
    return { Logger: { for: () => l } };
});

const mockWithBundleSlot = vi.fn(async (fn: () => Promise<unknown>, _waitMs?: number) => fn());

class MockBundleBusyError extends Error {}

vi.mock('$lib/server/services/client-diagnostics/semaphore.js', () => ({
    withBundleSlot: (...args: [() => Promise<unknown>, number?]) => mockWithBundleSlot(...args),
    BundleBusyError: MockBundleBusyError,
}));

const { def: listDef } = await import('./index.js');
const { def: detailDef } = await import('./[id]/index.js');
const { def: blobDef } = await import('./[id]/blob.js');
const { def: reportDef } = await import('./[id]/github-report.js');
const { registerJellyfinReportBuilder, __resetJellyfinReportBuilderForTests } =
    await import('$lib/server/compat/jellyfin-report-provider.js');

function makeRow(overrides: Partial<ClientDiagnosticRow> = {}): ClientDiagnosticRow {
    return {
        id: 1,
        event_id: '7f3a91c2-0000-0000-0000-000000000000',
        kind: 'js_error',
        user_id: null,
        device_id: null,
        platform: 'web',
        app_version: null,
        app_build: null,
        os_version: null,
        device_model: null,
        play_session_id: null,
        attempt_id: null,
        media_id: null,
        occurred_at: new Date('2026-09-26T12:00:00Z'),
        received_at: new Date('2026-09-26T12:00:01Z'),
        fingerprint: null,
        occurrences: 1,
        summary: 'TypeError: x is not a function',
        payload: {},
        resolved_at: null,
        username: null,
        device_name: null,
        media_title: null,
        has_blob: false,
        ...overrides,
    };
}

function makeEvent(url = 'http://localhost/api/admin/diagnostics'): RequestEvent {
    return { url: new URL(url), locals: {} } as unknown as RequestEvent;
}

function makeListCtx(
    query: Record<string, unknown> = {},
): ApiContext<NonNullable<typeof listDef.request>> {
    return {
        surface: 'internal',
        input: {
            body: undefined,
            params: undefined,
            query: {
                kind: undefined,
                platform: undefined,
                userId: undefined,
                deviceId: undefined,
                appVersion: undefined,
                fingerprint: undefined,
                resolved: undefined,
                from: undefined,
                to: undefined,
                q: undefined,
                all: undefined,
                limit: 50,
                offset: 0,
                ...query,
            },
        },
    } as unknown as ApiContext<NonNullable<typeof listDef.request>>;
}

function makeDetailCtx(id: number): ApiContext<NonNullable<typeof detailDef.request>> {
    return {
        surface: 'internal',
        input: { body: undefined, params: { id }, query: undefined },
    } as unknown as ApiContext<NonNullable<typeof detailDef.request>>;
}

function makeBlobCtx(
    id: number,
    format: 'gzip' | 'text' = 'gzip',
): ApiContext<NonNullable<typeof blobDef.request>> {
    return {
        surface: 'internal',
        input: { body: undefined, params: { id }, query: { format } },
    } as unknown as ApiContext<NonNullable<typeof blobDef.request>>;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockAuditActor.mockReturnValue({ username: 'admin1' });
    mockWithBundleSlot.mockImplementation(async (fn: () => Promise<unknown>) => fn());
});

describe('GET /admin/diagnostics', () => {
    it('maps rows to summaries and passes kinds array for repeated ?kind=', async () => {
        mockListClientDiagnostics.mockResolvedValue({ rows: [makeRow()], total: 1 });

        const handler = listDef.handlers.GET!;
        const res = (await handler(
            makeEvent(),
            makeListCtx({ kind: ['crash', 'hang'] }),
        )) as Response;

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            items: { id: number; shortId: string; occurredAt: string }[];
            page: { total?: number; hasMore: boolean };
        };
        expect(body.items).toHaveLength(1);
        expect(body.items[0].shortId).toBe('7F3A-91C2');
        expect(body.items[0].occurredAt).toBe('2026-09-26T12:00:00.000Z');
        expect(body.page.total).toBe(1);
        expect(body.page.hasMore).toBe(false);

        expect(mockListClientDiagnostics).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ kinds: ['crash', 'hang'] }),
        );
    });

    it('returns 503 when the DB is down', async () => {
        mockGetDb.mockReturnValue(null);
        const handler = listDef.handlers.GET!;
        const res = (await handler(makeEvent(), makeListCtx())) as Response;
        expect(res.status).toBe(503);
        expect(mockListClientDiagnostics).not.toHaveBeenCalled();
    });
});

describe('DELETE /admin/diagnostics', () => {
    it('422s with no filter and no all=true, and never calls deleteClientDiagnostics', async () => {
        const handler = listDef.handlers.DELETE!;
        const res = (await handler(makeEvent(), makeListCtx())) as Response;
        expect(res.status).toBe(422);
        expect(mockDeleteClientDiagnostics).not.toHaveBeenCalled();
        expect(mockAuditLog).not.toHaveBeenCalled();
    });

    it('with ?kind=js_error calls deleteClientDiagnostics with { kinds: ["js_error"] } and audits the clear', async () => {
        mockDeleteClientDiagnostics.mockResolvedValue(3);
        const handler = listDef.handlers.DELETE!;
        const res = (await handler(makeEvent(), makeListCtx({ kind: ['js_error'] }))) as Response;

        expect(res.status).toBe(200);
        const body = (await res.json()) as { cleared: number };
        expect(body.cleared).toBe(3);

        expect(mockDeleteClientDiagnostics).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ kinds: ['js_error'] }),
            expect.objectContaining({ allowAll: false }),
        );
        expect(mockAuditLog).toHaveBeenCalledWith(
            'client_diagnostics.clear',
            'client_diagnostics',
            expect.anything(),
            expect.objectContaining({ cleared: 3 }),
        );
    });

    it('with all=true and no other filter allows the clear', async () => {
        mockDeleteClientDiagnostics.mockResolvedValue(100);
        const handler = listDef.handlers.DELETE!;
        const res = (await handler(makeEvent(), makeListCtx({ all: 'true' }))) as Response;

        expect(res.status).toBe(200);
        expect(mockDeleteClientDiagnostics).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ allowAll: true }),
        );
    });

    it('?q=x&all=true 422s (search-scoped clear is not supported) and never calls deleteClientDiagnostics', async () => {
        const handler = listDef.handlers.DELETE!;
        const res = (await handler(makeEvent(), makeListCtx({ q: 'x', all: 'true' }))) as Response;

        expect(res.status).toBe(422);
        expect(mockDeleteClientDiagnostics).not.toHaveBeenCalled();
    });

    it('?q=x alone 422s too', async () => {
        const handler = listDef.handlers.DELETE!;
        const res = (await handler(makeEvent(), makeListCtx({ q: 'x' }))) as Response;

        expect(res.status).toBe(422);
        expect(mockDeleteClientDiagnostics).not.toHaveBeenCalled();
    });
});

describe('query schema: blank string params mean "no filter"', () => {
    it('GET ?appVersion=&q= parses to undefined for both', () => {
        const parsed = listDef.request!.query!.parse({
            appVersion: '',
            q: '',
            deviceId: '',
            userId: '',
            fingerprint: '',
            platform: '',
        }) as {
            appVersion?: string;
            q?: string;
            deviceId?: string;
            userId?: string;
            fingerprint?: string;
            platform?: string;
        };
        expect(parsed.appVersion).toBeUndefined();
        expect(parsed.q).toBeUndefined();
        expect(parsed.deviceId).toBeUndefined();
        expect(parsed.userId).toBeUndefined();
        expect(parsed.fingerprint).toBeUndefined();
        expect(parsed.platform).toBeUndefined();
    });

    it('whitespace-only filters and dates are blank too', () => {
        const parsed = listDef.request!.query!.parse({
            deviceId: '   ',
            appVersion: ' ',
            from: '',
            to: '',
        }) as Record<string, unknown>;
        expect(parsed.deviceId).toBeUndefined();
        expect(parsed.appVersion).toBeUndefined();
        expect(parsed.from).toBeUndefined();
        expect(parsed.to).toBeUndefined();
    });

    it('DELETE ?deviceId=%20 is unscoped — 422, not a 500 from the query guard', async () => {
        const parsedQuery = listDef.request!.query!.parse({ deviceId: ' ' });
        const res = (await listDef.handlers.DELETE!(
            makeEvent(),
            makeListCtx(parsedQuery as Record<string, unknown>),
        )) as Response;
        expect(res.status).toBe(422);
        expect(mockDeleteClientDiagnostics).not.toHaveBeenCalled();
    });

    it('DELETE ?appVersion= (blank) parses as unscoped — 422 without all=true', async () => {
        const parsedQuery = listDef.request!.query!.parse({ appVersion: '' });
        const handler = listDef.handlers.DELETE!;
        const res = (await handler(
            makeEvent(),
            makeListCtx(parsedQuery as Record<string, unknown>),
        )) as Response;

        expect(res.status).toBe(422);
        expect(mockDeleteClientDiagnostics).not.toHaveBeenCalled();
    });
});

describe('GET /admin/diagnostics/[id]', () => {
    it('404s when the row is missing', async () => {
        mockGetClientDiagnosticById.mockResolvedValue(null);
        const handler = detailDef.handlers.GET!;
        const res = (await handler(makeEvent(), makeDetailCtx(999))) as Response;
        expect(res.status).toBe(404);
    });

    it('200s with payload and blob metadata when present', async () => {
        mockGetClientDiagnosticById.mockResolvedValue(
            makeRow({
                has_blob: true,
                payload: { name: 'TypeError', message: 'x is not a function' },
                ...({
                    blob_content_bytes: 1024,
                    blob_uncompressed_bytes: 4096,
                    blob_sha256: 'abc123',
                } as unknown as Partial<ClientDiagnosticRow>),
            }),
        );
        const handler = detailDef.handlers.GET!;
        const res = (await handler(makeEvent(), makeDetailCtx(1))) as Response;
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            payload: Record<string, unknown>;
            blob: { contentBytes: number; uncompressedBytes: number; sha256: string } | null;
        };
        expect(body.payload).toEqual({ name: 'TypeError', message: 'x is not a function' });
        expect(body.blob).toEqual({
            contentBytes: 1024,
            uncompressedBytes: 4096,
            sha256: 'abc123',
        });
    });
});

describe('DELETE /admin/diagnostics/[id]', () => {
    it('404s when nothing was deleted', async () => {
        mockDeleteClientDiagnosticById.mockResolvedValue(0);
        const handler = detailDef.handlers.DELETE!;
        const res = (await handler(makeEvent(), makeDetailCtx(999))) as Response;
        expect(res.status).toBe(404);
        expect(mockAuditLog).not.toHaveBeenCalled();
    });

    it('200s and audits client_diagnostics.delete when a row was removed', async () => {
        mockDeleteClientDiagnosticById.mockResolvedValue(1);
        const handler = detailDef.handlers.DELETE!;
        const res = (await handler(makeEvent(), makeDetailCtx(1))) as Response;
        expect(res.status).toBe(200);
        const body = (await res.json()) as { cleared: number };
        expect(body.cleared).toBe(1);
        expect(mockAuditLog).toHaveBeenCalledWith(
            'client_diagnostics.delete',
            '1',
            expect.anything(),
            expect.anything(),
        );
    });
});

describe('GET /admin/diagnostics/[id]/blob', () => {
    it('404s when there is no log bundle for this diagnostic', async () => {
        mockGetLogBundleBlob.mockResolvedValue(null);
        const handler = blobDef.handlers.GET!;
        const res = (await handler(makeEvent(), makeBlobCtx(1))) as Response;
        expect(res.status).toBe(404);
    });

    it('returns application/gzip with the short-id filename by default', async () => {
        const gz = gzipSync(Buffer.from('hello world', 'utf8'));
        mockGetLogBundleBlob.mockResolvedValue({
            content: gz,
            event_id: '7f3a91c2-0000-0000-0000-000000000000',
        });
        const handler = blobDef.handlers.GET!;
        const res = (await handler(makeEvent(), makeBlobCtx(1, 'gzip'))) as Response;

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/gzip');
        expect(res.headers.get('content-disposition')).toBe(
            'attachment; filename="diagnostic-7F3A-91C2.log.gz"',
        );
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        const buf = Buffer.from(await res.arrayBuffer());
        expect(buf.equals(gz)).toBe(true);

        expect(mockAuditLog).toHaveBeenCalledWith(
            'client_diagnostics.blob_download',
            '1',
            expect.anything(),
            expect.objectContaining({ format: 'gzip' }),
        );
    });

    it('?format=text inflates server-side and returns text/plain equal to the inflated text', async () => {
        const gz = gzipSync(Buffer.from('hello world', 'utf8'));
        mockGetLogBundleBlob.mockResolvedValue({
            content: gz,
            event_id: '7f3a91c2-0000-0000-0000-000000000000',
        });
        const handler = blobDef.handlers.GET!;
        const res = (await handler(makeEvent(), makeBlobCtx(1, 'text'))) as Response;

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('content-disposition')).toBe(
            'inline; filename="diagnostic-7F3A-91C2.log"',
        );
        const text = await res.text();
        expect(text).toBe('hello world');

        expect(mockAuditLog).toHaveBeenCalledTimes(1);
        expect(mockAuditLog).toHaveBeenCalledWith(
            'client_diagnostics.blob_download',
            '1',
            expect.anything(),
            expect.objectContaining({ format: 'text' }),
        );
        expect(mockWithBundleSlot).toHaveBeenCalledTimes(1);
    });

    it('maps an inflate failure to a problem response, not a thrown 500 with internals', async () => {
        mockGetLogBundleBlob.mockResolvedValue({
            content: Buffer.from('not actually gzip'),
            event_id: '7f3a91c2-0000-0000-0000-000000000000',
        });
        const handler = blobDef.handlers.GET!;
        const res = (await handler(makeEvent(), makeBlobCtx(1, 'text'))) as Response;
        expect(res.status).toBeGreaterThanOrEqual(400);
        const body = (await res.json()) as { error?: string };
        expect(JSON.stringify(body)).not.toMatch(/at inflateBounded|node_modules|\.ts:\d+/);
    });

    it('returns 503 dependency_unavailable when the inflate slot is busy', async () => {
        const gz = gzipSync(Buffer.from('hello world', 'utf8'));
        mockGetLogBundleBlob.mockResolvedValue({
            content: gz,
            event_id: '7f3a91c2-0000-0000-0000-000000000000',
        });
        mockWithBundleSlot.mockRejectedValue(
            new MockBundleBusyError('bundle upload capacity exhausted'),
        );

        const handler = blobDef.handlers.GET!;
        const res = (await handler(makeEvent(), makeBlobCtx(1, 'text'))) as Response;

        expect(res.status).toBe(503);
        const body = (await res.json()) as { error?: string };
        expect(JSON.stringify(body)).not.toMatch(/at inflateBounded|node_modules|\.ts:\d+/);
    });
});

describe('GET /admin/diagnostics/[id]/github-report', () => {
    const makeCtx = (id: number) =>
        ({
            surface: 'internal',
            input: { body: undefined, params: { id }, query: undefined },
        }) as unknown as ApiContext<NonNullable<typeof reportDef.request>>;
    const stubBuilder = () =>
        registerJellyfinReportBuilder((input) => ({
            markdown: `md ${input.kind}`,
            issueUrl: 'https://github.com/Sapd/lumastra/issues/new?template=jellyfin-client.yml',
            report: { kind: input.kind },
        }));

    beforeEach(() => {
        __resetJellyfinReportBuilderForTests();
    });

    it('is admin-only (403 for non-admins comes from the auth layer)', () => {
        expect(reportDef.auth).toEqual({ kind: 'admin' });
    });

    it('404s when no report builder is registered (AGPL-only build)', async () => {
        mockGetClientDiagnosticById.mockResolvedValue(makeRow({ kind: 'compat_incident' }));
        const res = (await reportDef.handlers.GET!(makeEvent(), makeCtx(1))) as Response;
        expect(res.status).toBe(404);
    });

    it('404s for an unknown id', async () => {
        stubBuilder();
        mockGetClientDiagnosticById.mockResolvedValue(null);
        const res = (await reportDef.handlers.GET!(makeEvent(), makeCtx(9))) as Response;
        expect(res.status).toBe(404);
    });

    it('409s for a non-Jellyfin log bundle', async () => {
        stubBuilder();
        mockGetClientDiagnosticById.mockResolvedValue(
            makeRow({ kind: 'log_bundle', payload: { source: 'ios' }, has_blob: true }),
        );
        const res = (await reportDef.handlers.GET!(makeEvent(), makeCtx(1))) as Response;
        expect(res.status).toBe(409);
    });

    it('200s with an issue URL for a compat incident', async () => {
        stubBuilder();
        mockGetClientDiagnosticById.mockResolvedValue(
            makeRow({ kind: 'compat_incident', payload: { source: 'jellyfin_compat' } }),
        );
        const res = (await reportDef.handlers.GET!(makeEvent(), makeCtx(1))) as Response;
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.issueUrl.startsWith('https://github.com/Sapd/lumastra/issues/new')).toBe(true);
        expect(mockAuditLog).toHaveBeenCalledWith(
            'client_diagnostics.github_report',
            '1',
            expect.anything(),
            expect.anything(),
        );
    });
    it("passes the server's own host names to the builder (URL host and Host header)", async () => {
        let seen: string[] | undefined;
        registerJellyfinReportBuilder((input) => {
            seen = input.serverHosts;
            return {
                markdown: 'm',
                issueUrl: 'https://github.com/Sapd/lumastra/issues/new',
                report: {},
            };
        });
        mockGetClientDiagnosticById.mockResolvedValue(
            makeRow({ kind: 'compat_incident', payload: { source: 'jellyfin_compat' } }),
        );
        const event = {
            url: new URL('https://media.example.org:8443/api/admin/diagnostics/1/github-report'),
            request: { headers: new Headers({ host: 'lumastra.lan:3000' }) },
            locals: {},
        } as unknown as RequestEvent;
        const res = (await reportDef.handlers.GET!(event, makeCtx(1))) as Response;
        expect(res.status).toBe(200);
        expect(seen).toEqual(expect.arrayContaining(['media.example.org', 'lumastra.lan']));
    });

    it('passes the inflated log text to the builder for a Jellyfin log bundle', async () => {
        let seen: string | null | undefined;
        registerJellyfinReportBuilder((input) => {
            seen = input.logText;
            return {
                markdown: 'm',
                issueUrl: 'https://github.com/Sapd/lumastra/issues/new',
                report: {},
            };
        });
        mockGetClientDiagnosticById.mockResolvedValue(
            makeRow({ kind: 'log_bundle', payload: { source: 'jellyfin' }, has_blob: true }),
        );
        mockGetLogBundleBlob.mockResolvedValue({
            content: gzipSync(Buffer.from('line one\nline two', 'utf8')),
            event_id: '7f3a91c2-0000-0000-0000-000000000000',
        });
        const res = (await reportDef.handlers.GET!(makeEvent(), makeCtx(1))) as Response;
        expect(res.status).toBe(200);
        expect(seen).toBe('line one\nline two');
    });

    it('a corrupt bundle yields 200 without an excerpt and logs a warning', async () => {
        let seen: string | null | undefined = 'unset';
        registerJellyfinReportBuilder((input) => {
            seen = input.logText;
            return {
                markdown: 'm',
                issueUrl: 'https://github.com/Sapd/lumastra/issues/new',
                report: {},
            };
        });
        mockGetClientDiagnosticById.mockResolvedValue(
            makeRow({ kind: 'log_bundle', payload: { source: 'jellyfin' }, has_blob: true }),
        );
        mockGetLogBundleBlob.mockResolvedValue({
            content: Buffer.from('not gzip at all'),
            event_id: '7f3a91c2-0000-0000-0000-000000000000',
        });
        const res = (await reportDef.handlers.GET!(makeEvent(), makeCtx(1))) as Response;
        expect(res.status).toBe(200);
        expect(seen).toBeNull();
        expect(mockLogWarn).toHaveBeenCalled();
    });
});
