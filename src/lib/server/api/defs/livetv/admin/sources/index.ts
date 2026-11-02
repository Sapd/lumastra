// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/sources/index.ts
 *
 * GET  /livetv/admin/sources  — list all LiveTV sources with channel counts
 * POST /livetv/admin/sources  — create a new LiveTV source
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Response bodies:
 *   GET  → { sources: LiveTvSourceWithCount[] }        (bare object)
 *   POST → { source: LiveTvSource, taskIds? }          (bare object)
 */

import { probeLiveTvFeed } from '$lib/server/services/livetv/source-probe.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    getAllSourcesWithChannelCounts,
    createSource,
} from '$lib/server/database/queries/livetv-sources.queries.js';
import { CreateLiveTvSourceSchema } from '$lib/schemas/livetv.js';
import {
    validateXtreamCredentials,
    buildXtreamUrls,
    validateHdHomeRunDevice,
    buildEpgUrl,
} from '$lib/server/services/livetv/index.js';
import { validateUrl } from '$lib/server/utils/url-validator.js';
import { config } from '$lib/server/config.js';
import { isSealed } from '$lib/server/crypto/secret-box.js';
import {
    mapSourceToApi,
    mapSourceWithChannelCountToApi,
} from '$lib/server/mappers/livetv-source.mapper.js';
import { queueSourceImport } from '$lib/server/services/livetv/source-import-queue.js';
import { LiveTvSourcesListResponseSchema, LiveTvSourceResponseSchema } from '$lib/schemas/livetv';

const DEFAULT_REFRESH_CRON = '0 */12 * * *';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Live TV'],
            summary: 'List Live TV sources',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: LiveTvSourcesListResponseSchema,
                    description: 'All configured IPTV sources with channel counts',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Live TV'],
            summary: 'Create a new Live TV source',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                201: {
                    schema: LiveTvSourceResponseSchema,
                    description: 'Newly created source and any background import task IDs',
                },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Provider unreachable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        body: CreateLiveTvSourceSchema,
    },
    handlers: {
        GET: async () => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const sources = await getAllSourcesWithChannelCounts(sql);
            return json({ sources: sources.map(mapSourceWithChannelCountToApi) });
        },

        POST: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

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

            let m3uUrl = body.m3uUrl;
            let xmltvUrl = body.xmltvUrl;
            let hdHomeRunDeviceId: string | null = null;
            let maxStreams = body.maxStreams ?? 1;

            if (body.sourceType === 'xtream') {
                let validationResult;
                try {
                    validationResult = await validateXtreamCredentials({
                        serverUrl: body.xtreamServer!,
                        username: body.xtreamUsername!,
                        password: body.xtreamPassword!,
                    });
                } catch {
                    return ApiProblem.dependencyUnavailable('Xtream provider unreachable');
                }
                if (!validationResult.valid) {
                    return ApiProblem.validationFailed(
                        `Xtream credentials invalid: ${validationResult.reason}`,
                    );
                }
                const providerLimit = validationResult.serverInfo?.maxConnections;
                if (
                    body.maxStreams === undefined &&
                    providerLimit !== undefined &&
                    Number.isSafeInteger(providerLimit) &&
                    providerLimit > 0
                ) {
                    maxStreams = providerLimit;
                }
                // The credentialed URL is what actually gets fetched, so that is the
                // form validated below. It is NOT what gets stored: `createSource`
                // persists the bare URL and the sealed credentials, and
                // `getSourceByIdWithCredentials` rebuilds this URL at fetch time
                // (security review 2026-09-12, C8).
                const urls = buildXtreamUrls({
                    serverUrl: body.xtreamServer!,
                    username: body.xtreamUsername!,
                    password: body.xtreamPassword!,
                });
                m3uUrl = urls.m3uUrl;
                xmltvUrl = urls.xmltvUrl;
            }

            if (body.sourceType === 'hdhomerun') {
                if (!body.hdHomeRunDeviceIp) {
                    return ApiProblem.validationFailed(
                        'hdHomeRunDeviceIp is required for hdhomerun source type',
                    );
                }
                const deviceIp = body.hdHomeRunDeviceIp;
                let deviceResult;
                try {
                    deviceResult = await validateHdHomeRunDevice(deviceIp);
                } catch {
                    return ApiProblem.dependencyUnavailable('HDHomeRun device unreachable');
                }
                if (!deviceResult.valid) {
                    return ApiProblem.validationFailed(
                        `HDHomeRun device error: ${deviceResult.reason}`,
                    );
                }
                m3uUrl = `http://${deviceIp}/lineup.m3u`;
                xmltvUrl = buildEpgUrl(deviceResult.deviceInfo.deviceAuth) ?? undefined;
                hdHomeRunDeviceId = deviceResult.deviceInfo.deviceId;
                maxStreams = body.maxStreams ?? deviceResult.deviceInfo.tunerCount;
            }

            if (m3uUrl) {
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

            for (const [url, feed] of [
                [m3uUrl, 'M3U'],
                [xmltvUrl, 'XMLTV'],
            ] as const) {
                if (!url) continue;
                const problem = await probeLiveTvFeed(url, feed);
                if (problem) return ApiProblem.validationFailed(problem);
            }

            const created = await createSource(sql, {
                name: body.name,
                source_type: body.sourceType,
                m3u_url: m3uUrl ?? null,
                xmltv_url: xmltvUrl ?? null,
                xtream_server: body.xtreamServer ?? null,
                xtream_username: body.xtreamUsername ?? null,
                xtream_password: body.xtreamPassword ?? null,
                hdhomerun_device_ip: body.hdHomeRunDeviceIp ?? null,
                hdhomerun_device_id: hdHomeRunDeviceId,
                max_streams: maxStreams,
                refresh_cron: DEFAULT_REFRESH_CRON,
            });

            const by = event.locals.principal?.username ?? event.locals.user?.username ?? 'admin';
            // M3U queues EPG itself after the channels exist.
            const queued = m3uUrl ? await queueSourceImport(sql, created.id, 'import-m3u', by) : {};
            return json({ source: mapSourceToApi(created), ...queued }, { status: 201 });
        },
    },
});
