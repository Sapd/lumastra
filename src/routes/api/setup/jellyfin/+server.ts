// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/setup/jellyfin — admin-only: connect Jellyfin from the first-run
 * setup wizard.
 *
 * Flow: validate the entered URL+key against the live Jellyfin server FIRST
 * (so we never persist creds that don't work), then save them via the config
 * service — which calls resetJellyfinApi() so they take effect immediately, no
 * restart. Finally, resolve whether the admin's own username matches a Jellyfin
 * user, because watch-sync attributes history by name; a mismatch means the
 * admin's history would silently never import, which the wizard should warn about.
 *
 * Existing items trigger inventory immediately; otherwise the first library
 * scan triggers it. Inventory then starts a watch-history pull.
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders, jellyfinHttpError } from '$lib/server/jellyfin/auth-headers.js';
import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { saveConfig } from '$lib/server/config/config.service.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-timeout.js';
import { matchJellyfinUsername } from '$lib/server/jellyfin/match-user.js';
import { describeJellyfinUnreachable } from '$lib/server/jellyfin/unreachable-message.js';
import { isRecord, toStringOr } from '$lib/utils/data-extraction.js';
import { Logger } from '$lib/server/utils/logger.js';
import { features } from '$lib/server/config.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    getSetupJellyfinStatus,
    hasSetupJellyfinItems,
    type SetupJellyfinStatus,
} from '$lib/server/database/queries/onboarding.queries.js';
import { saveJellyfinSetupValue } from '$lib/server/database/queries/jellyfin-setup.queries.js';
import { requestJellyfinSetupInventory } from '$lib/server/services/jellyfin-setup-sync.service.js';
import type postgres from 'postgres';
import * as messages from '$lib/paraglide/messages.js';

const ENDPOINT = '/api/setup/jellyfin';
const PROBE_TIMEOUT_MS = 10_000;
const logger = Logger.for('SetupJellyfin');
const statusCache = new WeakMap<
    postgres.Sql,
    { expires: number; value: Promise<SetupJellyfinStatus> }
>();

async function cachedStatus(sql: postgres.Sql): Promise<SetupJellyfinStatus> {
    const cached = statusCache.get(sql);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = getSetupJellyfinStatus(sql);
    statusCache.set(sql, { expires: Date.now() + 5000, value });
    try {
        return await value;
    } catch (error) {
        statusCache.delete(sql);
        throw error;
    }
}

export const POST: RequestHandler = requireAdmin(
    withErrorHandler(async ({ request, locals }) => {
        let body: unknown;
        try {
            body = await readBoundedJson(request);
        } catch {
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        }
        if (!isRecord(body)) {
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        }

        const url = toStringOr(body.url, '').trim().replace(/\/+$/, '');
        const apiKey = toStringOr(body.apiKey, '').trim();
        if (!url || !apiKey) {
            return ApiResponses.badRequest('Both url and apiKey are required', undefined, ENDPOINT);
        }
        if (!/^https?:\/\//i.test(url)) {
            return ApiResponses.badRequest(
                'URL must start with http:// or https://',
                undefined,
                ENDPOINT,
            );
        }

        // 1. Probe the entered creds BEFORE saving, so bad creds are never persisted.
        let serverName: string | undefined;
        let version: string | undefined;
        try {
            const res = await fetchWithTimeout(
                joinUpstreamUrl(url, `/System/Info`),
                { headers: buildJellyfinAuthHeaders({ token: apiKey }) },
                PROBE_TIMEOUT_MS,
            );
            if (!res.ok) {
                return json({ connected: false, error: jellyfinHttpError(res.status) });
            }
            const info = (await res.json().catch(() => ({}))) as Record<string, unknown>;
            serverName = toStringOr(info.ServerName, '') || undefined;
            version = toStringOr(info.Version, '') || undefined;
        } catch (err) {
            return json({
                connected: false,
                error: describeJellyfinUnreachable(url, err, [apiKey]),
            });
        }

        // 2. Creds are good — persist them. saveConfig() calls resetJellyfinApi()
        //    so the running app picks them up live (no restart).
        await saveConfig({ JELLYFINURL: url, JELLYFINAPIKEY: apiKey });

        let syncStarted: boolean | undefined;
        let syncWarning: string | undefined;
        let sql: postgres.Sql | null = null;
        try {
            if (features.jellyfinSync) {
                sql = await aiDbService.getSql();
                if (!sql) throw new Error('Database unavailable');
                if (await hasSetupJellyfinItems(sql)) {
                    syncStarted = await requestJellyfinSetupInventory(sql, ENDPOINT, logger);
                    if (!syncStarted) syncWarning = messages.setup_jellyfin_sync_start_failed();
                }
            }
        } catch {
            syncStarted = false;
            syncWarning = messages.setup_jellyfin_sync_start_failed();
            logger.warn('Jellyfin follow-up could not start after saving the connection');
            if (sql) {
                try {
                    await saveJellyfinSetupValue(sql, 'kick-error', true);
                } catch {
                    logger.warn('Could not record Jellyfin follow-up status');
                }
            }
        } finally {
            if (sql) statusCache.delete(sql);
        }

        // 3. Best-effort: does the admin's own username match a Jellyfin user?
        //    A mismatch means their history won't import until names line up.
        const adminUsername = locals.user?.username ?? '';
        let adminMatched = false;
        let matchedName: string | null = null;
        try {
            const usersRes = await fetchWithTimeout(
                joinUpstreamUrl(url, `/Users`),
                { headers: buildJellyfinAuthHeaders({ token: apiKey }) },
                PROBE_TIMEOUT_MS,
            );
            if (usersRes.ok) {
                const users = (await usersRes.json().catch(() => [])) as Array<{ Name?: string }>;
                const names = Array.isArray(users)
                    ? users.map((u) => toStringOr(u?.Name, '')).filter((n) => n !== '')
                    : [];
                matchedName = matchJellyfinUsername(adminUsername, names);
                adminMatched = matchedName !== null;
            }
        } catch {
            // Non-fatal: connection already proven; just couldn't enumerate users.
            logger.warn('Could not enumerate Jellyfin users for admin-match check');
        }

        return json({
            connected: true,
            serverName,
            version,
            adminUsername,
            adminMatched,
            matchedName,
            syncStarted,
            warning: syncWarning,
        });
    }),
);

export const GET: RequestHandler = requireAdmin(
    withErrorHandler(async () => {
        if (!features.jellyfinSync) return json({ configured: false });
        try {
            const sql = await aiDbService.getSql();
            if (!sql) throw new Error('Database unavailable');
            return json({ configured: true, ...(await cachedStatus(sql)) });
        } catch {
            return ApiResponses.error(
                messages.setup_jellyfin_status_unavailable(),
                undefined,
                503,
                ENDPOINT,
            );
        }
    }),
);
