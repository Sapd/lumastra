// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { withValkeyRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { isRecord } from '$lib/utils/data-extraction';
import { getDisplayPreferences } from '$lib/server/database/queries/jellyfin-display-preferences.queries';
import {
    checkDisplayPreferencesBodySize,
    validateDisplayPreferencesIdentity,
    enforceDisplayPreferencesRowCap,
    upsertDisplayPreferencesOrTooLarge,
} from '$lib/server/jellyfin-compat/display-preferences-guard';

const DISPLAY_PREFS_ID = 'usersettings';

function defaultPreferences(client: string): Record<string, unknown> {
    return {
        Id: DISPLAY_PREFS_ID,
        SortBy: 'SortName',
        SortOrder: 'Ascending',
        RememberIndexing: false,
        RememberSorting: false,
        PrimaryImageHeight: 200,
        PrimaryImageWidth: 0,
        ScrollDirection: 'Horizontal',
        ShowBackdrop: true,
        ShowSidebar: false,
        CustomPrefs: {
            homesection0: 'smalllibrarytiles',
            homesection1: 'resume',
            homesection2: 'resumeaudio',
            homesection3: 'resumebook',
            homesection4: 'livetv',
            homesection5: 'nextup',
            homesection6: 'latestmedia',
        },
        Client: client,
    };
}

export const GET: RequestHandler = withJellyfinAuth(
    async (event) => {
        const sql = getDb();
        if (!sql) {
            return ApiResponses.error('Database unavailable');
        }

        const client = event.url.searchParams.get('client') || 'emby';
        const stored = await getDisplayPreferences(
            sql,
            event.locals.user.userId,
            DISPLAY_PREFS_ID,
            client,
        );

        if (!stored) {
            return json(defaultPreferences(client));
        }

        return json({
            ...defaultPreferences(client),
            ...stored,
            Id: DISPLAY_PREFS_ID,
            Client: client,
        });
    },
    { pat: 'deny' },
);

const rateLimitedPost = withValkeyRateLimit(
    60,
    60,
    (event: RequestEvent) => `jfcompat:displayprefs:${event.locals.user.username}`,
    { strict: true },
)(async (event: RequestEvent) => {
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    const client = event.url.searchParams.get('client') || 'emby';
    const identityError = validateDisplayPreferencesIdentity(DISPLAY_PREFS_ID, client);
    if (identityError) return identityError;

    let body: unknown;
    try {
        body = await readBoundedJson(event.request);
    } catch {
        return ApiResponses.badRequest('Invalid JSON body');
    }
    if (!isRecord(body) || Array.isArray(body)) {
        return ApiResponses.badRequest('Invalid DisplayPreferences body');
    }

    const sizeError = checkDisplayPreferencesBodySize(event.request, body);
    if (sizeError) return sizeError;

    const capError = await enforceDisplayPreferencesRowCap(
        sql,
        event.locals.user.userId,
        DISPLAY_PREFS_ID,
        client,
    );
    if (capError) return capError;

    const writeError = await upsertDisplayPreferencesOrTooLarge(
        sql,
        event.locals.user.userId,
        DISPLAY_PREFS_ID,
        client,
        body,
    );
    if (writeError) return writeError;

    return new Response(null, { status: 204 });
});

export const POST: RequestHandler = withJellyfinAuth(rateLimitedPost, {
    pat: 'deny',
    mode: 'write',
});
