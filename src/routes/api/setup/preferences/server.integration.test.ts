// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { config } from '$lib/server/config.js';
import { createNativeAdmin } from '$lib/server/database/queries/users.queries.js';

const connection = vi.hoisted(() => ({ sql: null as postgres.Sql | null }));
vi.mock('$lib/server/database/connection.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/connection.js')>()),
    getDb: () => connection.sql,
}));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditActor: () => ({ username: 'owner' }),
    auditLog: vi.fn(),
}));

const mockSaveConfig = vi.fn().mockResolvedValue(undefined);

vi.mock('$lib/server/config/config.service.js', () => ({
    saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));

function call(body: unknown) {
    return import('./+server.js').then(({ POST }) =>
        (POST as (event: unknown) => Promise<Response>)({
            // A real Request: the handler reads the body with readBoundedJson
            // (a capped stream read), not request.json().
            request: new Request('http://localhost/api/setup/preferences', {
                method: 'POST',
                body: JSON.stringify(body),
            }),
        }),
    );
}

describe('POST /api/setup/preferences', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('maps a full body to whitelisted config keys', async () => {
        const res = await call({
            appName: 'My Server',
            gpuAcceleration: 'nvenc',
            trickplayEnabled: true,
            introAnalyzer: false,
            autoLyrics: false,
            metadataStorageLocation: 'alongside-prefer',
            gravatar: true,
            unratedContentVisible: true,
        });
        const body = await res.json();

        expect(res.ok).toBe(true);
        expect(body.saved).toBe(true);
        expect(mockSaveConfig).toHaveBeenCalledWith(
            {
                APP_NAME: 'My Server',
                GPU_ACCELERATION: 'nvenc',
                TRICKPLAY_ENABLED: true,
                PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED: false,
                FEATURE_AUTO_LYRICS: false,
                METADATA_STORAGE_LOCATION: 'alongside-prefer',
                FEATURE_GRAVATAR: true,
                UNRATED_CONTENT_VISIBLE: true,
            },
            {
                // Keys the use-case projection also sets are pinned in settings.json.
                pinKeys: [
                    'FEATURE_AUTO_LYRICS',
                    'FEATURE_GRAVATAR',
                    'PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED',
                ],
            },
        );
    });

    it('only writes fields present in the body', async () => {
        const res = await call({ trickplayEnabled: true });
        const body = await res.json();

        expect(res.ok).toBe(true);
        expect(body.saved).toBe(true);
        expect(mockSaveConfig).toHaveBeenCalledWith({ TRICKPLAY_ENABLED: true });
    });

    it('ignores a blank instance name instead of overwriting the default', async () => {
        await call({ appName: '   ', trickplayEnabled: false });

        expect(mockSaveConfig).toHaveBeenCalledWith({ TRICKPLAY_ENABLED: false });
    });

    it('no-ops on an empty body without calling saveConfig', async () => {
        const res = await call({});
        const body = await res.json();

        expect(res.ok).toBe(true);
        expect(body.saved).toBe(false);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('rejects an invalid GPU acceleration value', async () => {
        const res = await call({ gpuAcceleration: 'magic' });

        expect(res.status).toBe(422);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('rejects an invalid metadata storage location', async () => {
        const res = await call({ metadataStorageLocation: 'somewhere' });

        expect(res.status).toBe(422);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('rejects an over-long instance name', async () => {
        const res = await call({ appName: 'x'.repeat(51) });

        expect(res.status).toBe(422);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('rejects a non-object body', async () => {
        const res = await call('not-json');

        expect(res.status).toBe(422);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });
});

const rollback = new Error('rollback setup preferences');
afterAll(async () => {
    await closeTestDb();
});

describe('setup sharing default applies to the existing owner', () => {
    it('saves OFF and hides the owner while preserving explicit sharing choices', async () => {
        const sharing = vi.spyOn(config, 'DEFAULT_ACTIVITY_SHARING', 'get').mockReturnValue(true);
        try {
            await getTestDb()
                .begin(async (sql) => {
                    await sql`CREATE TEMP TABLE users (LIKE public.users INCLUDING ALL) ON COMMIT DROP`;
                    await sql`CREATE TEMP TABLE setup_lock (LIKE public.setup_lock INCLUDING ALL) ON COMMIT DROP`;
                    connection.sql = sql;
                    await createNativeAdmin(sql, {
                        username: 'owner',
                        passwordHash: 'test-hash',
                        groups: [],
                        adminGroupNames: ['admins'],
                    });
                    const [owner] = await sql`SELECT * FROM users WHERE username = 'owner'`;
                    expect(owner).toMatchObject({
                        hide_streams: false,
                        share_listening_activity: true,
                        share_audiobook_activity: true,
                        sharing_explicitly_set_by_user: false,
                    });
                    await sql`INSERT INTO users (username, hide_streams, share_listening_activity,
                    share_audiobook_activity, sharing_explicitly_set_by_user)
                    VALUES ('explicit', false, true, true, true)`;
                    const [explicit] = await sql`SELECT * FROM users WHERE username = 'explicit'`;
                    mockSaveConfig.mockImplementationOnce(
                        async (updates: Record<string, unknown>) => {
                            expect(updates.DEFAULT_ACTIVITY_SHARING).toBe(false);
                            sharing.mockReturnValue(false);
                        },
                    );
                    expect((await call({ defaultActivitySharing: false })).status).toBe(200);
                    const [updated] = await sql`SELECT * FROM users WHERE username = 'owner'`;
                    expect(updated).toMatchObject({
                        hide_streams: true,
                        share_listening_activity: false,
                        share_audiobook_activity: false,
                        sharing_explicitly_set_by_user: false,
                        privacy_prefs_updated_at: null,
                    });
                    expect(await sql`SELECT * FROM users WHERE username = 'explicit'`).toEqual([
                        explicit,
                    ]);
                    expect((await call({ defaultActivitySharing: false })).status).toBe(200);
                    expect(await sql`SELECT * FROM users WHERE username = 'owner'`).toEqual([
                        updated,
                    ]);
                    throw rollback;
                })
                .catch((error: unknown) => {
                    if (error !== rollback) throw error;
                });
        } finally {
            connection.sql = null;
            sharing.mockRestore();
        }
    });
});
