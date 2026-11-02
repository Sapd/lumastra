// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/plugins/repositories — GET (list + catalog) / POST (add) / DELETE
 *
 * Repositories are admin-UI writable, unlike trusted keys, and the difference
 * is the trust argument: a repository grants ZERO trust. Adding one changes
 * what is ADVERTISED, never what can run — install still passes the same
 * signature, ABI and publisher-continuity gates against the same
 * operator-configured keys.
 *
 * The residual is that syncing fetches an admin-supplied URL, which is the
 * identical admin-scoped SSRF surface as a manual install and is mitigated
 * identically (public-IP pin, size cap, timeout).
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getDb } from '$lib/server/database/connection.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import {
    listRepositories,
    addRepository,
    removeRepository,
    listCatalogEntries,
} from '$lib/server/database/queries/plugin-repositories.queries.js';
import {
    syncRepository,
    syncAllRepositories,
} from '$lib/server/services/plugin-repository.service.js';

const AddBodySchema = z.object({ url: z.string().url() });
const RemoveBodySchema = z.object({ id: z.string().uuid() });

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getDb();
            if (!sql) return ApiResponses.error('database unavailable');
            const [repositories, catalog] = await Promise.all([
                listRepositories(sql),
                listCatalogEntries(sql),
            ]);
            return new Response(JSON.stringify({ repositories, catalog }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        },

        POST: async (event: RequestEvent) => {
            const sql = getDb();
            if (!sql) return ApiResponses.error('database unavailable');
            const raw: unknown = await readBoundedJson(event.request).catch(() => ({}));
            const parsed = AddBodySchema.safeParse(raw);
            if (!parsed.success) return ApiResponses.badRequest('a repository URL is required');

            const actor = event.locals.principal?.username ?? event.locals.user?.username ?? null;
            const repo = await addRepository(sql, parsed.data.url, actor);
            // Sync immediately so the operator finds out NOW whether the URL
            // serves a usable index, rather than discovering an empty catalog
            // and having to guess why.
            const outcome = await syncRepository(sql, repo);
            auditLog('plugin.repository.add', repo.id, auditActor(event), {
                url: repo.url,
                entries: outcome.entries,
                error: outcome.error ?? null,
            });
            return new Response(JSON.stringify({ repository: repo, sync: outcome }), {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
            });
        },

        DELETE: async (event: RequestEvent) => {
            const sql = getDb();
            if (!sql) return ApiResponses.error('database unavailable');
            const raw: unknown = await readBoundedJson(event.request).catch(() => ({}));
            const parsed = RemoveBodySchema.safeParse(raw);
            if (!parsed.success) return ApiResponses.badRequest('a repository id is required');
            await removeRepository(sql, parsed.data.id);
            auditLog('plugin.repository.remove', parsed.data.id, auditActor(event), {});
            return new Response(null, { status: 204 });
        },

        // Re-sync every enabled repository. The manual twin of the scheduled
        // check, so an operator is never waiting on a timer.
        PUT: async (event: RequestEvent) => {
            const sql = getDb();
            if (!sql) return ApiResponses.error('database unavailable');
            const outcomes = await syncAllRepositories(sql);
            auditLog('plugin.repository.sync', 'all', auditActor(event), {
                repositories: outcomes.length,
            });
            return new Response(JSON.stringify({ outcomes }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        },
    },
});
