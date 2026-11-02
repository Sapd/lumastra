// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C20: the four chunked-upload handlers (init/chunk/finalize/abort) resolve a
 * real caller identity for Bearer callers, instead of pooling every token
 * caller under a mismatched sentinel ('unknown' in init.ts, '' in the other
 * three).
 *
 * `/api/admin/*` is a surface forward-auth deliberately does NOT build a
 * Principal for on the Bearer path (hooks.server.ts's "Bearer exception" —
 * the route's own auth gate is the authority there). Before this fix, the
 * handlers read `event.locals.user?.username`, which forward-auth also never
 * populates for that path, so a PAT-initiated session was attributed to
 * 'unknown' and every subsequent chunk/finalize/abort by the SAME PAT 403'd
 * (its own ownership compare could never match the sentinel it wrote).
 *
 * This suite drives the REAL handlers through the REAL mount()/enforce()/
 * authenticate() chain (only the PAT validation call and the DB/service
 * layer below the defs are mocked), proving the fix at the seam: a Bearer
 * PAT can now complete init → chunk → finalize, a different PAT is denied,
 * and the concurrency counter keys off the resolved identity.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

const mockPatValidate = vi.fn();
vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: (...args: unknown[]) => mockPatValidate(...args) }),
}));
const mockSvcValidate = vi.fn().mockResolvedValue(null);
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: (...args: unknown[]) => mockSvcValidate(...args) }),
}));
const mockIsUserAdmin = vi.fn().mockReturnValue(false);
vi.mock('$lib/server/auth.js', () => ({
    isUserAdmin: (...args: unknown[]) => mockIsUserAdmin(...args),
}));
// Item 1 (2026-09-13 deferred fix): authenticate()'s svc_ branch resolves an
// identity too now (mirroring forward-auth.ts's handleServiceTokenAuth) — the
// non-impersonating case resolves the CREATING admin's users.id.
const mockResolveUserIdByUsername = vi.fn();
vi.mock('$lib/server/auth/resolve-user-id.js', () => ({
    resolveUserIdByUsername: (...args: unknown[]) => mockResolveUserIdByUsername(...args),
}));

// fix-plan-5 Task 3: the PAT owner axis of the shared token-identity.ts
// producer (`authenticate()`'s pat_ branch, via mount.ts's {kind:'scope'} C20
// fallback these tests drive) resolves identity via resolveTokenUserAccess()
// instead of trusting the raw pat.service.validate() row directly. This
// suite only cares that the resolved userId/username/userGroups round-trip
// (the scope check below is 'library:admin', granted directly off the
// token's own scopes — never gated on isAdmin), so the mock derives its
// answer straight from the SAME `patValidated()` row `mockPatValidate` is
// configured with per test, rather than hitting a real (unconfigured in this
// suite) Postgres connection.
vi.mock('$lib/server/auth/resolve-token-user-access.js', () => ({
    resolveTokenUserAccess: async (username: string) => {
        const validated = await mockPatValidate();
        if (!validated || validated.username !== username) return null;
        return {
            userGroups: validated.groups ?? [],
            disabled: false,
            deleted: false,
            permissions: {
                hasWatchPermission: true,
                hasLiveTvPermission: true,
                hasRequestPermission: false,
                hasReviewPermission: false,
                hasMediaAnnotationPermission: false,
                // The owner IS admin: since 2026-10-02 a token whose owner is
                // not currently admin loses its admin-class scopes
                // (stripsAdminScopesForToken() in principal.ts), and this
                // suite's 'library:admin' PAT must reach the handler.
                ownerIsAdmin: true,
                maxAgeRating: null,
                isAgeRestricted: false,
                isModerator: false,
                liveTvPriority: 'low',
            },
        };
    },
    computeOwnerMaxAge: () => null,
    mergeMaxAge: (a: number | null, b: number | null) =>
        a === null ? b : b === null ? a : Math.min(a, b),
    MOST_RESTRICTIVE_AGE_RATING: 0,
}));

// Non-impersonating service-token CREATOR axis of the shared token-identity
// producer: the creator is a current admin.
vi.mock('$lib/server/auth/resolve-owner-admin-status.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/auth/resolve-owner-admin-status.js')>();
    return {
        ...actual,
        resolveOwnerIsAdminFailClosed: async () => true,
        resolveOwnerIsAdminFailClosedById: async () => true,
    };
});

vi.mock('$lib/server/database/index.js', () => ({
    getDb: () => ({}) as unknown,
}));

const mockGetLibraryPathById = vi.fn();
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getLibraryPathById: (...args: unknown[]) => mockGetLibraryPathById(...args),
}));

const mockGetUploadSessionById = vi.fn();
const mockCountActiveUploadSessionsForUser = vi.fn().mockResolvedValue(0);
vi.mock('$lib/server/database/queries/upload-sessions.queries.js', () => ({
    getUploadSessionById: (...args: unknown[]) => mockGetUploadSessionById(...args),
    countActiveUploadSessionsForUser: (...args: unknown[]) =>
        mockCountActiveUploadSessionsForUser(...args),
}));

const mockInitUpload = vi.fn();
const mockWriteChunk = vi.fn();
const mockFinalizeUpload = vi.fn();
const mockAbortUpload = vi.fn();
vi.mock('$lib/server/services/upload-session.service.js', () => ({
    UPLOADABLE_LIBRARY_TYPES: new Set(['home_video', 'training', 'educational', 'personal']),
    initUpload: (...args: unknown[]) => mockInitUpload(...args),
    writeChunk: (...args: unknown[]) => mockWriteChunk(...args),
    finalizeUpload: (...args: unknown[]) => mockFinalizeUpload(...args),
    abortUpload: (...args: unknown[]) => mockAbortUpload(...args),
}));

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: vi.fn().mockResolvedValue({ runId: undefined }) },
}));
vi.mock('$lib/server/tasks/builtin/native/file-delta-ingest-queue.js', () => ({
    enqueueDeltaPayload: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/config.js', () => ({
    config: { UPLOAD_CHUNK_SIZE_MB: 10 },
    features: {},
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { mount } from '$lib/server/api/mount.js';
import { def as initDef } from './init.js';
import { def as chunkDef } from './chunks/[uploadId].js';
import { def as finalizeDef } from './finalize.js';
import { def as abortDef } from './[uploadId].js';

const CTX = { surface: 'internal' } as const;
const { POST: initPOST } = mount(initDef, CTX);
const { PUT: chunkPUT } = mount(chunkDef, CTX);
const { POST: finalizePOST } = mount(finalizeDef, CTX);
const { DELETE: abortDELETE } = mount(abortDef, CTX);

const LIB_PATH = {
    id: 'lib-1',
    path: '/data/home-videos',
    media_type: 'home_video',
    language: 'en',
    provider: 'none',
    enabled: true,
    provider_path: null,
    library_group_id: 'grp-1',
    edition_label: null,
    scan_chapters: false,
    fallback_providers: [],
    source_prefix: null,
    created_at: new Date(),
    updated_at: new Date(),
};

/** A PAT owned by `username` (with `userId`/`groups`), as pat.service.validate() returns it. */
function patValidated(opts: { username: string; userId: string; groups?: string[] }) {
    return {
        id: Math.floor(Math.random() * 1e6),
        userId: opts.userId,
        username: opts.username,
        name: 'upload token',
        scopes: ['library:admin'],
        groups: opts.groups ?? [],
        jellyfinUserId: null,
        tokenPrefix: 'pat_xxx',
        allowedIps: null,
    };
}

/** A non-impersonating service token, as service-token.service.validate() returns it. */
function svcValidated(opts: { name: string; createdBy: string; ownerUserId?: string | null }) {
    return {
        id: Math.floor(Math.random() * 1e6),
        name: opts.name,
        createdBy: opts.createdBy,
        // The owner, by id (API package 15).
        ownerUserId:
            opts.ownerUserId === undefined
                ? '99999999-9999-4999-8999-999999999999'
                : opts.ownerUserId,
        actAsUser: null,
        allowedPathPrefixes: null,
        allowedMethods: null,
        forceNonAdmin: false,
        // Literal 'admin' + an admin creator (mockResolveOwnerIsAdminFailClosed
        // below): the producer's service-token verdict requires both, and a
        // non-admin verdict strips admin-class scopes since 2026-10-02.
        scopes: ['admin'],
    };
}

function bearerEvent(opts: {
    method: string;
    token?: string;
    params: Record<string, string>;
    body?: unknown;
    cookieAdmin?: { username: string; isAdmin: boolean };
    raw?: Uint8Array;
}): RequestEvent {
    const url = new URL('http://localhost/api/admin/upload/test');
    const headers = new Headers();
    if (opts.token) headers.set('authorization', `Bearer ${opts.token}`);
    const init: RequestInit = { method: opts.method, headers };
    if (opts.body !== undefined) {
        headers.set('content-type', 'application/json');
        init.body = JSON.stringify(opts.body);
    } else if (opts.raw) {
        init.body = opts.raw as BodyInit;
    }

    return {
        url,
        request: new Request(url.toString(), init),
        params: opts.params,
        route: { id: '/api/admin/upload/test' as const },
        locals: opts.cookieAdmin
            ? {
                  user: {
                      username: opts.cookieAdmin.username,
                      ownerIsAdmin: opts.cookieAdmin.isAdmin,
                  },
                  principal: {
                      kind: 'forward_auth' as const,
                      userId: toUserId('99999999-9999-4999-8999-999999999999'),
                      username: opts.cookieAdmin.username,
                      userGroups: [],
                      scopes: opts.cookieAdmin.isAdmin ? ['admin'] : ['read', 'write'],
                      isAdmin: opts.cookieAdmin.isAdmin,
                  },
              }
            : { user: undefined, principal: undefined },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const ALICE_ID = '11111111-1111-4111-8111-111111111111';
const BOB_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
    vi.clearAllMocks();
    mockCountActiveUploadSessionsForUser.mockResolvedValue(0);
    mockGetLibraryPathById.mockResolvedValue(LIB_PATH);
    mockSvcValidate.mockResolvedValue(null);
});

describe('C20: chunked-upload handlers resolve a real caller identity for Bearer callers', () => {
    it('init → chunk → finalize succeeds end to end for one PAT (201/200/200), attributed to its real username', async () => {
        mockPatValidate.mockResolvedValue(patValidated({ username: 'alice', userId: ALICE_ID }));
        mockInitUpload.mockResolvedValue({
            uploadId: 'up-1',
            chunkSize: 1024,
            expiresAt: new Date().toISOString(),
        });

        const initRes = await initPOST!(
            bearerEvent({
                method: 'POST',
                token: 'pat_alice',
                params: { libraryPathId: 'lib-1' },
                body: { filename: 'a.mp4', mimeType: 'video/mp4', totalSize: 10, totalChunks: 1 },
            }),
        );
        expect(initRes.status).toBe(201);
        // Real identity, not the old 'unknown' sentinel.
        expect(mockInitUpload).toHaveBeenCalledWith(
            expect.objectContaining({ uploaderUser: 'alice' }),
        );
        expect(mockCountActiveUploadSessionsForUser).toHaveBeenCalledWith(
            expect.anything(),
            'alice',
        );

        const session = {
            id: 'up-1',
            library_path_id: 'lib-1',
            uploader_user: 'alice',
            filename: 'a.mp4',
            mime_type: 'video/mp4',
            total_size: 10,
            total_chunks: 1,
            chunks_received: 0,
            destination_folder: '',
            staging_dir: '/tmp/up-1',
            status: 'uploading',
            error_message: null,
            media_item_id: null,
            sha256_expected: null,
            sha256_actual: null,
        };
        mockGetUploadSessionById.mockResolvedValue(session);
        mockWriteChunk.mockResolvedValue(1);

        const chunkRes = await chunkPUT!(
            bearerEvent({
                method: 'PUT',
                token: 'pat_alice',
                params: { libraryPathId: 'lib-1', uploadId: 'up-1', chunkIndex: '0' },
                raw: new Uint8Array([1, 2, 3]),
            }),
        );
        expect(chunkRes.status).toBe(200);

        mockFinalizeUpload.mockResolvedValue({ finalPath: '/data/home-videos/a.mp4' });
        const finalizeRes = await finalizePOST!(
            bearerEvent({
                method: 'POST',
                token: 'pat_alice',
                params: { libraryPathId: 'lib-1', uploadId: 'up-1' },
                body: { totalChunks: 1 },
            }),
        );
        expect(finalizeRes.status).toBe(200);
    });

    it("a second PAT's chunk/finalize/abort on that session all 403", async () => {
        const session = {
            id: 'up-2',
            library_path_id: 'lib-1',
            uploader_user: 'alice',
            filename: 'a.mp4',
            mime_type: 'video/mp4',
            total_size: 10,
            total_chunks: 1,
            chunks_received: 0,
            destination_folder: '',
            staging_dir: '/tmp/up-2',
            status: 'uploading',
            error_message: null,
            media_item_id: null,
            sha256_expected: null,
            sha256_actual: null,
        };
        mockGetUploadSessionById.mockResolvedValue(session);
        mockPatValidate.mockResolvedValue(patValidated({ username: 'bob', userId: BOB_ID }));

        const chunkRes = await chunkPUT!(
            bearerEvent({
                method: 'PUT',
                token: 'pat_bob',
                params: { libraryPathId: 'lib-1', uploadId: 'up-2', chunkIndex: '0' },
                raw: new Uint8Array([1]),
            }),
        );
        expect(chunkRes.status).toBe(403);

        const finalizeRes = await finalizePOST!(
            bearerEvent({
                method: 'POST',
                token: 'pat_bob',
                params: { libraryPathId: 'lib-1', uploadId: 'up-2' },
                body: { totalChunks: 1 },
            }),
        );
        expect(finalizeRes.status).toBe(403);

        const abortRes = await abortDELETE!(
            bearerEvent({
                method: 'DELETE',
                token: 'pat_bob',
                params: { libraryPathId: 'lib-1', uploadId: 'up-2' },
            }),
        );
        expect(abortRes.status).toBe(403);

        expect(mockWriteChunk).not.toHaveBeenCalled();
        expect(mockFinalizeUpload).not.toHaveBeenCalled();
        expect(mockAbortUpload).not.toHaveBeenCalled();
    });

    it('a cookie admin vs a token session 403s both ways', async () => {
        const tokenOwnedSession = {
            id: 'up-3',
            library_path_id: 'lib-1',
            uploader_user: 'alice',
            filename: 'a.mp4',
            mime_type: 'video/mp4',
            total_size: 10,
            total_chunks: 1,
            chunks_received: 0,
            destination_folder: '',
            staging_dir: '/tmp/up-3',
            status: 'uploading',
            error_message: null,
            media_item_id: null,
            sha256_expected: null,
            sha256_actual: null,
        };
        mockGetUploadSessionById.mockResolvedValue(tokenOwnedSession);

        // Cookie admin (no Bearer) hitting the PAT-owned session → 403.
        const cookieOnTokenRes = await abortDELETE!(
            bearerEvent({
                method: 'DELETE',
                params: { libraryPathId: 'lib-1', uploadId: 'up-3' },
                cookieAdmin: { username: 'carol-admin', isAdmin: true },
            }),
        );
        expect(cookieOnTokenRes.status).toBe(403);

        // Token caller hitting a cookie-admin-owned session → 403.
        const cookieOwnedSession = {
            ...tokenOwnedSession,
            id: 'up-4',
            uploader_user: 'carol-admin',
        };
        mockGetUploadSessionById.mockResolvedValue(cookieOwnedSession);
        mockPatValidate.mockResolvedValue(patValidated({ username: 'alice', userId: ALICE_ID }));
        const tokenOnCookieRes = await abortDELETE!(
            bearerEvent({
                method: 'DELETE',
                token: 'pat_alice',
                params: { libraryPathId: 'lib-1', uploadId: 'up-4' },
            }),
        );
        expect(tokenOnCookieRes.status).toBe(403);
        expect(mockAbortUpload).not.toHaveBeenCalled();
    });

    it('an unresolved Bearer identity 401s init instead of pooling under a sentinel', async () => {
        mockPatValidate.mockResolvedValue(null); // invalid/expired PAT
        const res = await initPOST!(
            bearerEvent({
                method: 'POST',
                token: 'pat_bad',
                params: { libraryPathId: 'lib-1' },
                body: { filename: 'a.mp4', mimeType: 'video/mp4', totalSize: 10, totalChunks: 1 },
            }),
        );
        expect(res.status).toBe(401);
        expect(mockInitUpload).not.toHaveBeenCalled();
    });

    it('the concurrency counter is keyed by the real identity, not shared across different PATs', async () => {
        mockInitUpload.mockResolvedValue({
            uploadId: 'up-5',
            chunkSize: 1024,
            expiresAt: new Date().toISOString(),
        });

        mockPatValidate.mockResolvedValue(patValidated({ username: 'alice', userId: ALICE_ID }));
        await initPOST!(
            bearerEvent({
                method: 'POST',
                token: 'pat_alice',
                params: { libraryPathId: 'lib-1' },
                body: { filename: 'a.mp4', mimeType: 'video/mp4', totalSize: 10, totalChunks: 1 },
            }),
        );
        expect(mockCountActiveUploadSessionsForUser).toHaveBeenLastCalledWith(
            expect.anything(),
            'alice',
        );

        mockPatValidate.mockResolvedValue(patValidated({ username: 'bob', userId: BOB_ID }));
        await initPOST!(
            bearerEvent({
                method: 'POST',
                token: 'pat_bob',
                params: { libraryPathId: 'lib-1' },
                body: { filename: 'b.mp4', mimeType: 'video/mp4', totalSize: 10, totalChunks: 1 },
            }),
        );
        expect(mockCountActiveUploadSessionsForUser).toHaveBeenLastCalledWith(
            expect.anything(),
            'bob',
        );
    });
});

// Item 1 (2026-09-13 deferred fix): authenticate()'s svc_ branch previously
// left `identity` unset unconditionally, so mount.ts's {kind:'scope'} C20
// fallback never materialised a Principal for a service-token caller and
// these same four handlers fell back to `event.locals.principal?.username ??
// event.locals.user?.username ?? null` → null → 401, for EVERY service-token
// caller regardless of scope. This drives the SAME real
// mount()/enforce()/authenticate() chain as the PAT suite above, but with a
// service token, through a full init → chunk → finalize cycle — the seam the
// brief requires (not authenticate() in isolation).
describe('item 1: chunked-upload handlers resolve a real caller identity for SERVICE-TOKEN Bearer callers', () => {
    it('init → chunk → finalize succeeds end to end for a non-impersonating service token (201/200/200), attributed to service:<name>', async () => {
        mockSvcValidate.mockResolvedValue(
            svcValidated({ name: 'ci-uploader', createdBy: 'the-admin' }),
        );
        mockResolveUserIdByUsername.mockResolvedValue('99999999-9999-4999-8999-999999999999');
        mockInitUpload.mockResolvedValue({
            uploadId: 'up-svc-1',
            chunkSize: 1024,
            expiresAt: new Date().toISOString(),
        });

        const initRes = await initPOST!(
            bearerEvent({
                method: 'POST',
                token: 'svc_ciuploader',
                params: { libraryPathId: 'lib-1' },
                body: { filename: 'a.mp4', mimeType: 'video/mp4', totalSize: 10, totalChunks: 1 },
            }),
        );
        expect(initRes.status).toBe(201);
        // Real identity, not a 401 (the pre-fix behaviour for EVERY
        // service-token caller) and not pooled under a sentinel.
        expect(mockInitUpload).toHaveBeenCalledWith(
            expect.objectContaining({ uploaderUser: 'service:ci-uploader' }),
        );
        expect(mockCountActiveUploadSessionsForUser).toHaveBeenCalledWith(
            expect.anything(),
            'service:ci-uploader',
        );

        const session = {
            id: 'up-svc-1',
            library_path_id: 'lib-1',
            uploader_user: 'service:ci-uploader',
            filename: 'a.mp4',
            mime_type: 'video/mp4',
            total_size: 10,
            total_chunks: 1,
            chunks_received: 0,
            destination_folder: '',
            staging_dir: '/tmp/up-svc-1',
            status: 'uploading',
            error_message: null,
            media_item_id: null,
            sha256_expected: null,
            sha256_actual: null,
        };
        mockGetUploadSessionById.mockResolvedValue(session);
        mockWriteChunk.mockResolvedValue(1);

        const chunkRes = await chunkPUT!(
            bearerEvent({
                method: 'PUT',
                token: 'svc_ciuploader',
                params: { libraryPathId: 'lib-1', uploadId: 'up-svc-1', chunkIndex: '0' },
                raw: new Uint8Array([1, 2, 3]),
            }),
        );
        expect(chunkRes.status).toBe(200);

        mockFinalizeUpload.mockResolvedValue({ finalPath: '/data/home-videos/a.mp4' });
        const finalizeRes = await finalizePOST!(
            bearerEvent({
                method: 'POST',
                token: 'svc_ciuploader',
                params: { libraryPathId: 'lib-1', uploadId: 'up-svc-1' },
                body: { totalChunks: 1 },
            }),
        );
        expect(finalizeRes.status).toBe(200);
    });

    it('an unresolvable owner (fail-closed) 403s init instead of pooling under a sentinel', async () => {
        // No owner_user_id -> the shared producer denies (403) -> enforce()'s
        // {kind:'scope'} catch maps that to scope_required (403), not a silent
        // sentinel identity.
        mockSvcValidate.mockResolvedValue(
            svcValidated({ name: 'ghost', createdBy: 'ghost-admin', ownerUserId: null }),
        );
        mockResolveUserIdByUsername.mockResolvedValue(null);

        const res = await initPOST!(
            bearerEvent({
                method: 'POST',
                token: 'svc_ghost',
                params: { libraryPathId: 'lib-1' },
                body: { filename: 'a.mp4', mimeType: 'video/mp4', totalSize: 10, totalChunks: 1 },
            }),
        );
        expect(res.status).toBe(403);
        expect(mockInitUpload).not.toHaveBeenCalled();
    });

    it('the concurrency counter is keyed by the real service-token identity, distinct from a PAT identity', async () => {
        mockInitUpload.mockResolvedValue({
            uploadId: 'up-svc-2',
            chunkSize: 1024,
            expiresAt: new Date().toISOString(),
        });

        mockSvcValidate.mockResolvedValue(
            svcValidated({ name: 'ci-uploader', createdBy: 'the-admin' }),
        );
        mockResolveUserIdByUsername.mockResolvedValue('99999999-9999-4999-8999-999999999999');
        await initPOST!(
            bearerEvent({
                method: 'POST',
                token: 'svc_ciuploader',
                params: { libraryPathId: 'lib-1' },
                body: { filename: 'a.mp4', mimeType: 'video/mp4', totalSize: 10, totalChunks: 1 },
            }),
        );
        expect(mockCountActiveUploadSessionsForUser).toHaveBeenLastCalledWith(
            expect.anything(),
            'service:ci-uploader',
        );

        mockSvcValidate.mockResolvedValue(null);
        mockPatValidate.mockResolvedValue(patValidated({ username: 'alice', userId: ALICE_ID }));
        await initPOST!(
            bearerEvent({
                method: 'POST',
                token: 'pat_alice',
                params: { libraryPathId: 'lib-1' },
                body: { filename: 'b.mp4', mimeType: 'video/mp4', totalSize: 10, totalChunks: 1 },
            }),
        );
        expect(mockCountActiveUploadSessionsForUser).toHaveBeenLastCalledWith(
            expect.anything(),
            'alice',
        );
    });
});
