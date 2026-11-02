// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * serveContainedMediaFile on a real filesystem: a media path stored in the DB at
 * scan time must not serve a link swapped in afterwards.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveContainedMediaFile } from './file-streaming.js';
import { setSensitivePrefixesForTests } from './contained-fs.js';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackDirectPlay: vi.fn(), trackSession: vi.fn() },
}));

describe('serveContainedMediaFile', () => {
    let lib: string;
    let secrets: string;

    beforeEach(async () => {
        lib = await mkdtemp(join(tmpdir(), 'scmf-lib-'));
        secrets = await mkdtemp(join(tmpdir(), 'scmf-config-'));
        await writeFile(join(secrets, 'master.key'), 'TESTKEY-123');
        setSensitivePrefixesForTests([secrets]);
    });
    afterEach(async () => {
        setSensitivePrefixesForTests([]);
        await rm(lib, { recursive: true, force: true });
        await rm(secrets, { recursive: true, force: true });
    });

    it('serves the file the scan saw', async () => {
        await writeFile(join(lib, 'Movie.mkv'), 'MEDIA-BYTES');
        const res = await serveContainedMediaFile(join(lib, 'Movie.mkv'), null);
        expect(res?.status).toBe(200);
        expect(res?.headers.get('content-type')).toBe('video/x-matroska');
        expect(await res?.text()).toBe('MEDIA-BYTES');
    });

    it('refuses the file swapped for a link into a sensitive dir after the scan', async () => {
        const p = join(lib, 'Movie.mkv');
        await writeFile(p, 'MEDIA-BYTES');
        await rm(p);
        await symlink(join(secrets, 'master.key'), p);
        expect(await serveContainedMediaFile(p, null)).toBeNull();
        expect(await serveContainedMediaFile(p, 'bytes=0-3')).toBeNull();
    });

    it('refuses a file under a directory swapped for a link into a sensitive dir', async () => {
        await mkdir(join(lib, 'Movie'));
        await writeFile(join(lib, 'Movie', 'master.key'), 'MEDIA-BYTES');
        await rm(join(lib, 'Movie'), { recursive: true });
        await symlink(secrets, join(lib, 'Movie'));
        expect(await serveContainedMediaFile(join(lib, 'Movie', 'master.key'), null)).toBeNull();
    });

    it('serves a debrid link outside the library, typed by the link name', async () => {
        const mount = await mkdtemp(join(tmpdir(), 'scmf-debrid-'));
        try {
            await writeFile(join(mount, 'a1b2c3'), 'DEBRID-BYTES');
            await symlink(join(mount, 'a1b2c3'), join(lib, 'Movie.mkv'));
            const res = await serveContainedMediaFile(join(lib, 'Movie.mkv'), 'bytes=0-5');
            expect(res?.status).toBe(206);
            expect(res?.headers.get('content-type')).toBe('video/x-matroska');
            expect(await res?.text()).toBe('DEBRID');
        } finally {
            await rm(mount, { recursive: true, force: true });
        }
    });
});
