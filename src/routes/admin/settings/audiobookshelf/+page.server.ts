// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Settings → AudiobookShelf.
 *
 * Integration-level state, mirroring how Jellyfin is split: configuration lives
 * in settings, CONTENT lives in the library surfaces. This page carries the
 * connection, sync health, the ingest knobs and the per-user minted credentials.
 * Which libraries are ingested is /admin/library/sources; the books themselves
 * are /admin/library/media.
 */

import { redirect, fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { appPath } from '$lib/shared/api-urls.js';
import {
    loadSettingsForSections,
    saveSettingsAction,
    reloadSettingsAction,
} from '$lib/server/admin/settings-helpers';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    getRecentAudiobookshelfSyncRuns,
    getAudiobookshelfLinkedUsers,
    AUDIOBOOKSHELF_SYNC_TASK_ID,
} from '$lib/server/database/queries/audiobookshelf-admin.queries.js';
import { getAllLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { getTaskSettings } from '$lib/server/database/queries/task-settings.queries.js';
import {
    AUDIOBOOKSHELF_SOURCE_ID,
    resolveSyncIntervalMinutes,
} from '$lib/server/tasks/builtin/native/media-sources/audiobookshelf.js';
import {
    resolveDismissalRatio,
    DISMISS_MAX_PERCENT_KEY,
} from '$lib/server/tasks/builtin/native/media-sources/_helpers/audiobookshelf/sweep.js';
import { PluginSecrets } from '$lib/server/tasks/secrets.js';
import {
    unlinkUserApiKey,
    AUDIOBOOKSHELF_PLUGIN_ID,
} from '$lib/server/services/audiobookshelf-credentials.service.js';
import { audiobookshelfClient } from '$lib/server/audiobookshelf.js';
import { Logger } from '$lib/server/utils/logger.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('AdminAudiobookshelfSettings');

export const load: PageServerLoad = async ({ locals }) => {
    // Same gate as the /admin layout: the RESOLVED verdict. Re-deriving it from
    // IdP groups misses both non-group admin paths — the `admin_pinned` DB
    // override and the in-app `admin` capability (see buildUserPermissions).
    if (!localsIsAdmin(locals)) {
        throw redirect(302, appPath('/'));
    }

    // The `conn-audiobookshelf` section is exactly this integration's settings
    // (it is also the Audiobookshelf card on Settings → Connections).
    const scoped = await loadSettingsForSections(['conn-audiobookshelf']);

    const sql = await aiDbService.getSql();
    if (!sql) {
        // The connection form is still useful with no database — that is often
        // exactly the state an operator is in. Degrade the DB-backed panels
        // rather than failing the page.
        return {
            ...scoped,
            warnings: ['Database unavailable — sync history and linked users could not be loaded.'],
            syncRuns: [],
            linkedUsers: [],
            libraryCount: 0,
            syncIntervalMinutes: null,
            dismissalPercent: null,
            syncTaskId: AUDIOBOOKSHELF_SYNC_TASK_ID,
        };
    }

    const [syncRuns, linkedUsers, allPaths, ingestSettings] = await Promise.all([
        getRecentAudiobookshelfSyncRuns(sql),
        getAudiobookshelfLinkedUsers(sql),
        getAllLibraryPaths(sql),
        getTaskSettings(sql, AUDIOBOOKSHELF_SOURCE_ID),
    ]);

    return {
        ...scoped,
        warnings: [] as string[],
        syncRuns,
        linkedUsers,
        libraryCount: allPaths.filter((p) => p.provider === 'audiobookshelf' && p.enabled).length,
        // Resolved through the SAME helpers the sweep and scheduler use, so the
        // page cannot display a value that differs from the one in force. Showing
        // the raw stored setting would drift from the clamped effective value.
        syncIntervalMinutes: resolveSyncIntervalMinutes(ingestSettings),
        dismissalPercent: Math.round(resolveDismissalRatio(ingestSettings) * 100),
        dismissMaxPercentKey: DISMISS_MAX_PERCENT_KEY,
        syncTaskId: AUDIOBOOKSHELF_SYNC_TASK_ID,
    };
};

// `satisfies` rather than `: Actions` — the annotation ERASES the per-action
// return types, which collapses the generated `ActionData` to `{}` and makes
// every `form.<field>` read in the page a type error. `satisfies` keeps the
// same constraint check AND the inference.
export const actions = {
    save: async ({ request, locals }) => saveSettingsAction(request, locals),
    reload: async ({ locals }) => reloadSettingsAction(locals),

    /**
     * Revoke one user's minted AudiobookShelf key.
     *
     * Goes through `unlinkUserApiKey` rather than deleting the credential rows
     * directly: the upstream key stays live and usable if only the local row is
     * dropped, so a user who believes they were unlinked would still have a
     * working credential on the AudiobookShelf server.
     */
    revoke: async ({ request, locals }) => {
        // Same gate as the /admin layout: the RESOLVED verdict. Re-deriving it from
        // IdP groups misses both non-group admin paths — the `admin_pinned` DB
        // override and the in-app `admin` capability (see buildUserPermissions).
        if (!localsIsAdmin(locals)) {
            return fail(403, { revokeError: 'Admin access required' });
        }

        const form = await request.formData();
        const userId = String(form.get('userId') ?? '').trim();
        if (!userId) {
            return fail(400, { revokeError: 'A user must be selected' });
        }

        const sql = await aiDbService.getSql();
        if (!sql) {
            return fail(503, { revokeError: 'Database unavailable' });
        }

        try {
            await unlinkUserApiKey({
                secrets: new PluginSecrets(sql),
                deps: {
                    // `listUsers` / `createApiKey` are unused by unlink, but the
                    // deps interface is shared with the minting path. Throwing
                    // beats a silent no-op stub if unlink ever starts calling them.
                    listUsers: () => {
                        throw new Error('listUsers is not used by unlink');
                    },
                    createApiKey: () => {
                        throw new Error('createApiKey is not used by unlink');
                    },
                    deactivateApiKey: (id) => audiobookshelfClient.deactivateApiKey(id),
                },
                userId,
            });
        } catch (err) {
            logger.error('Failed to revoke AudiobookShelf credential', {
                userId,
                pluginId: AUDIOBOOKSHELF_PLUGIN_ID,
                error: err instanceof Error ? err.message : String(err),
            });
            return fail(500, { revokeError: 'Could not revoke the credential' });
        }

        return { revoked: true };
    },
} satisfies Actions;
