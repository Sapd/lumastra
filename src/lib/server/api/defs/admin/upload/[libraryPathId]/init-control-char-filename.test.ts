// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * P1 (fix plan 6, Task 7 / S-P1): `init.ts`'s zod schema accepted any
 * `filename` up to 512 chars, including one containing a raw control
 * character (e.g. `\n`). Node's `basename()` (`upload-session.service.ts`)
 * does not strip embedded control bytes, so such a name could survive to
 * `finalPath` and, for a split-file (concat) item, reach the ffmpeg concat
 * list `writeConcatTmpFile` builds under `-safe 0` — where an embedded
 * newline splits the list into an attacker-influenced extra `file`
 * directive. Rejecting it here (422 `validation_failed`, this mount's
 * standard zod-schema-failure status), at the very first seam an uploaded
 * filename crosses, is defense-in-depth alongside the later seams — the
 * scanner gates, `resolveUnderRoot` and the concat list's own throw, all
 * listed in `filename-safety.ts` — which share the same `hasControlChars()`
 * helper.
 *
 * Drives the real `mount()`/`enforce()`/`validateRequest()` chain for a
 * cookie-admin caller so the assertion is at the seam (the def's own zod
 * schema), not a call to a helper mocked into a vacuum.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('$lib/server/database/index.js', () => ({
    getDb: () => ({}) as unknown,
}));

const mockGetLibraryPathById = vi.fn();
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getLibraryPathById: (...args: unknown[]) => mockGetLibraryPathById(...args),
}));

const mockCountActiveUploadSessionsForUser = vi.fn().mockResolvedValue(0);
vi.mock('$lib/server/database/queries/upload-sessions.queries.js', () => ({
    countActiveUploadSessionsForUser: (...args: unknown[]) =>
        mockCountActiveUploadSessionsForUser(...args),
}));

const mockInitUpload = vi.fn();
vi.mock('$lib/server/services/upload-session.service.js', () => ({
    UPLOADABLE_LIBRARY_TYPES: new Set(['home_video', 'training', 'educational', 'personal']),
    initUpload: (...args: unknown[]) => mockInitUpload(...args),
}));

vi.mock('$lib/server/config.js', () => ({
    config: { UPLOAD_CHUNK_SIZE_MB: 10 },
    features: {},
}));

import { mount } from '$lib/server/api/mount.js';
import { def as initDef } from './init.js';

const CTX = { surface: 'internal' } as const;
const { POST: initPOST } = mount(initDef, CTX);

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

function adminEvent(body: unknown): RequestEvent {
    const url = new URL('http://localhost/api/admin/upload/test');
    const headers = new Headers({ 'content-type': 'application/json' });
    return {
        url,
        request: new Request(url.toString(), {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        }),
        params: { libraryPathId: 'lib-1' },
        route: { id: '/api/admin/upload/test' as const },
        locals: {
            user: { username: 'carol-admin', ownerIsAdmin: true },
            principal: {
                kind: 'forward_auth' as const,
                userId: '99999999-9999-4999-8999-999999999999',
                username: 'carol-admin',
                userGroups: [],
                scopes: ['admin'],
                isAdmin: true,
            },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockCountActiveUploadSessionsForUser.mockResolvedValue(0);
    mockGetLibraryPathById.mockResolvedValue(LIB_PATH);
    mockInitUpload.mockResolvedValue({
        uploadId: 'up-1',
        chunkSize: 1024,
        expiresAt: new Date().toISOString(),
    });
});

describe('P1: init.ts rejects a control-character filename', () => {
    it('422s (validation_failed) a filename containing an embedded newline, never reaching initUpload', async () => {
        const res = await initPOST!(
            adminEvent({
                filename: "Movie.Part2\nfile '/tmp/outside.mkv'.mkv",
                mimeType: 'video/mp4',
                totalSize: 10,
                totalChunks: 1,
            }),
        );
        expect(res.status).toBe(422);
        expect(mockInitUpload).not.toHaveBeenCalled();
    });

    it('422s (validation_failed) a filename containing an embedded carriage return', async () => {
        const res = await initPOST!(
            adminEvent({
                filename: 'Movie\rPart2.mkv',
                mimeType: 'video/mp4',
                totalSize: 10,
                totalChunks: 1,
            }),
        );
        expect(res.status).toBe(422);
        expect(mockInitUpload).not.toHaveBeenCalled();
    });

    // Control: an ordinary filename must keep working.
    it('accepts a normal filename (control)', async () => {
        const res = await initPOST!(
            adminEvent({
                filename: 'Movie Part2.mkv',
                mimeType: 'video/mp4',
                totalSize: 10,
                totalChunks: 1,
            }),
        );
        expect(res.status).toBe(201);
        expect(mockInitUpload).toHaveBeenCalled();
    });
});

// F4 (fix plan 6, Task 7 fix round 1): destinationFolder had no control-char
// check at all — same 422 treatment as filename, at the same seam.
describe('F4: init.ts rejects a control-character destinationFolder', () => {
    it('422s (validation_failed) a destinationFolder containing an embedded newline', async () => {
        const res = await initPOST!(
            adminEvent({
                filename: 'Movie.mkv',
                mimeType: 'video/mp4',
                totalSize: 10,
                totalChunks: 1,
                destinationFolder: "Uploads\nfile '/tmp/outside.mkv'",
            }),
        );
        expect(res.status).toBe(422);
        expect(mockInitUpload).not.toHaveBeenCalled();
    });

    // Control: a normal destinationFolder keeps working.
    it('accepts a normal destinationFolder (control)', async () => {
        const res = await initPOST!(
            adminEvent({
                filename: 'Movie.mkv',
                mimeType: 'video/mp4',
                totalSize: 10,
                totalChunks: 1,
                destinationFolder: 'Uploads/2026',
            }),
        );
        expect(res.status).toBe(201);
        expect(mockInitUpload).toHaveBeenCalled();
    });
});
