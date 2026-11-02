// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/sources/[id]/index.ts
 *
 * PUT    /livetv/admin/sources/{sourceId} — update a LiveTV source
 * DELETE /livetv/admin/sources/{sourceId} — delete a LiveTV source
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Response bodies:
 *   PUT    → { source: LiveTvSource }   (bare object)
 *   DELETE → { deleted: true }          (bare object)
 */

import * as m from '$lib/paraglide/messages.js';
import { probeLiveTvFeed } from '$lib/server/services/livetv/source-probe.js';
import { queueSourceImport } from '$lib/server/services/livetv/source-import-queue.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    getSourceByIdWithCredentials,
    updateSource,
    deleteSource,
} from '$lib/server/database/queries/livetv-sources.queries.js';
import { UpdateLiveTvSourceSchema } from '$lib/schemas/livetv.js';
import {
    validateXtreamCredentials,
    buildXtreamUrls,
    validateHdHomeRunDevice,
    buildEpgUrl,
} from '$lib/server/services/livetv/index.js';
import { validateUrl } from '$lib/server/utils/url-validator.js';
import { config } from '$lib/server/config.js';
import { isSealed } from '$lib/server/crypto/secret-box.js';
import { mapSourceToApi } from '$lib/server/mappers/livetv-source.mapper.js';
import { LiveTvSourceResponseSchema, SourceDeletedResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        PUT: {
            tags: ['Live TV'],
            summary: 'Update a Live TV source',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: { schema: LiveTvSourceResponseSchema, description: 'Updated source' },
                401: 'Authentication required',
                404: 'Source not found',
                422: 'Validation failed',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Live TV'],
            summary: 'Delete a Live TV source',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: { schema: SourceDeletedResponseSchema, description: 'Source deleted' },
                401: 'Authentication required',
                404: 'Source not found',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        params: z.object({ sourceId: z.string().min(1) }),
        body: UpdateLiveTvSourceSchema,
    },
    handlers: {
        PUT: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { sourceId } = ctx.input!.params;
            const body = ctx.input!.body;

            // Reject a client-supplied credential that is already sealed
            // (`enc:v1:`/`enc:v2:`) before it ever reaches the query module.
            // The query module's own pass-through for an already-sealed value
            // exists for internal callers (rotation, a value read back from
            // the DB) — it must not let an HTTP caller plant a foreign
            // envelope, bound to a different row/column, into this row
            // (security review 2026-09-13, C19).
            if (body.xtreamUsername !== undefined && isSealed(body.xtreamUsername)) {
                return ApiProblem.validationFailed(
                    'xtreamUsername must not be a pre-sealed credential value',
                );
            }
            if (body.xtreamPassword !== undefined && isSealed(body.xtreamPassword)) {
                return ApiProblem.validationFailed(
                    'xtreamPassword must not be a pre-sealed credential value',
                );
            }

            const existing = await getSourceByIdWithCredentials(sql, sourceId);
            if (!existing) return ApiProblem.notFound('Source not found');

            let m3uUrl = body.m3uUrl;
            let xmltvUrl = body.xmltvUrl;
            let hdHomeRunDeviceId: string | undefined;
            const hdHomeRunChanged =
                existing.source_type === 'hdhomerun' &&
                body.hdHomeRunDeviceIp !== undefined &&
                body.hdHomeRunDeviceIp !== existing.hdhomerun_device_ip;
            if (hdHomeRunChanged) {
                let result;
                try {
                    result = await validateHdHomeRunDevice(body.hdHomeRunDeviceIp!);
                } catch {
                    return ApiProblem.dependencyUnavailable(
                        m.livetv_admin_feed_unreachable({ feed: 'HDHomeRun' }),
                    );
                }
                if (!result.valid) return ApiProblem.validationFailed(result.reason);
                m3uUrl = `http://${body.hdHomeRunDeviceIp}/lineup.m3u`;
                xmltvUrl = body.xmltvUrl ?? buildEpgUrl(result.deviceInfo.deviceAuth) ?? '';
                hdHomeRunDeviceId = result.deviceInfo.deviceId;
            }

            const xtreamFieldsChanged =
                body.xtreamServer !== undefined ||
                body.xtreamUsername !== undefined ||
                body.xtreamPassword !== undefined;

            if (existing.source_type === 'xtream' && xtreamFieldsChanged) {
                const serverUrl = body.xtreamServer ?? existing.xtream_server ?? '';
                const username = body.xtreamUsername ?? existing.xtream_username ?? '';
                const password = body.xtreamPassword ?? existing.xtream_password ?? '';

                let validationResult;
                try {
                    validationResult = await validateXtreamCredentials({
                        serverUrl,
                        username,
                        password,
                    });
                } catch {
                    return ApiProblem.dependencyUnavailable('Xtream provider unreachable');
                }
                if (!validationResult.valid) {
                    return ApiProblem.validationFailed(
                        `Xtream credentials invalid: ${validationResult.reason}`,
                    );
                }
                // Credentialed form for validation only — see the create route and
                // security review 2026-09-12, C8. `updateSource` stores the bare
                // URL and the sealed credentials.
                const urls = buildXtreamUrls({ serverUrl, username, password });
                m3uUrl = urls.m3uUrl;
                xmltvUrl = body.xmltvUrl ?? (existing.xmltv_url ? urls.xmltvUrl : '');
            }

            if (m3uUrl !== undefined) {
                const m3uValidation = await validateUrl(m3uUrl, {
                    allowPrivateIps: config.LIVETV_ALLOW_PRIVATE_URLS,
                });
                if (!m3uValidation.valid) {
                    return ApiProblem.validationFailed(`Invalid M3U URL: ${m3uValidation.reason}`);
                }
            }

            if (xmltvUrl) {
                const xmltvValidation = await validateUrl(xmltvUrl, {
                    allowPrivateIps: config.LIVETV_ALLOW_PRIVATE_URLS,
                });
                if (!xmltvValidation.valid) {
                    return ApiProblem.validationFailed(
                        `Invalid XMLTV URL: ${xmltvValidation.reason}`,
                    );
                }
            }

            const m3uChanged =
                (m3uUrl !== undefined && m3uUrl !== existing.m3u_url) ||
                (existing.source_type === 'xtream' &&
                    ((body.xtreamServer !== undefined &&
                        body.xtreamServer !== existing.xtream_server) ||
                        (body.xtreamUsername !== undefined &&
                            body.xtreamUsername !== existing.xtream_username) ||
                        (body.xtreamPassword !== undefined &&
                            body.xtreamPassword !== existing.xtream_password)));
            const epgChanged = xmltvUrl !== undefined && (xmltvUrl || null) !== existing.xmltv_url;
            for (const [url, feed, changed] of [
                [m3uUrl, 'M3U', m3uChanged],
                [xmltvUrl, 'XMLTV', epgChanged],
            ] as const) {
                if (!url || !changed) continue;
                const problem = await probeLiveTvFeed(url, feed);
                if (problem) return ApiProblem.validationFailed(problem);
            }

            const updated = await updateSource(sql, sourceId, {
                name: body.name,
                // An UPDATE does not otherwise carry the type, and `updateSource`
                // needs it to know whether these URLs are rebuildable from the
                // sealed credentials (and so may be stored bare). Same value the
                // row already holds — this route cannot change a source's type.
                source_type: existing.source_type,
                m3u_url: m3uUrl,
                xmltv_url: xmltvUrl === '' ? null : xmltvUrl,
                hdhomerun_device_ip: hdHomeRunChanged ? body.hdHomeRunDeviceIp : undefined,
                hdhomerun_device_id: hdHomeRunDeviceId,
                xtream_server: body.xtreamServer,
                xtream_username: body.xtreamUsername,
                xtream_password: body.xtreamPassword,
                max_streams: body.maxStreams,
                refresh_cron: body.refreshCron,
            });

            if (!updated) return ApiProblem.notFound('Source not found');

            const retryM3u = existing.last_refresh_status === 'failed';
            const summary = existing.last_refresh_summary as { epg?: { status?: string } } | null;
            const retryEpg = summary?.epg?.status === 'failed';
            const task = m3uChanged
                ? 'import-m3u'
                : retryM3u && (m3uUrl ?? existing.m3u_url)
                  ? 'refresh-m3u'
                  : (epgChanged || retryEpg) && (xmltvUrl ?? existing.xmltv_url)
                    ? 'import-epg'
                    : undefined;
            const by = event.locals.principal?.username ?? event.locals.user?.username ?? 'admin';
            const queued = task ? await queueSourceImport(sql, sourceId, task, by) : {};
            return json({ source: mapSourceToApi(updated), ...queued });
        },

        DELETE: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { sourceId } = ctx.input!.params;

            const { deleted } = await deleteSource(sql, sourceId);
            if (!deleted) return ApiProblem.notFound('Source not found');

            return json({ deleted: true });
        },
    },
});
