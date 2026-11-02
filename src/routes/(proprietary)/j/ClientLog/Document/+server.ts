// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { storeJellyfinClientLog } from '$lib/server/proprietary/jellyfin-compat/client-log-bundle';
import { Logger } from '$lib/server/utils/logger';
import { EXCERPT_CHARS, readCappedBody } from './client-log';

const logger = Logger.for('JellyfinCompat:ClientLog');

/**
 * Client log upload.
 *
 * jellyfin-androidtv posts its log here roughly every 70 minutes and retries
 * about 15 times when the post fails, so having no route cost 510 × 404 from a
 * single television in one day — by a wide margin the loudest thing in the /j
 * access log, and every one of them noise.
 *
 * Unlike upstream Jellyfin we do NOT keep a downloadable document. The upload is
 * stored as a client-diagnostics log bundle instead (admin-readable, scrubbed,
 * covered by the per-user byte budget, newest 5 per device) and also logged,
 * truncated, to the server log. The returned FileName is a handle for that
 * log entry, not a promise of a downloadable file.
 */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { locals } = event;
        const device = locals.jfDevice;

        // Bounded read: the ceiling has to bound what is ALLOCATED, not just
        // what is logged, and it has to count bytes rather than UTF-16 code
        // units. See readCappedBody.
        const { text: kept, truncated, bytes } = await readCappedBody(event.request);

        const clientName = device?.clientName ?? 'unknown-client';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `${clientName.replace(/[^\w.-]+/g, '_')}_${stamp}.log`;

        logger.info('Client log uploaded', {
            fileName,
            clientName,
            deviceName: device?.deviceName ?? null,
            // `|| null`, not `??`: a session minted before device tracking
            // existed carries an empty string, and '' is not a device id.
            deviceId: device?.deviceId || null,
            username: locals.user?.username ?? null,
            bytes,
            truncated,
            excerpt: kept.slice(0, EXCERPT_CHARS),
        });

        const sql = getDb();
        const userId = locals.user?.userId;
        if (sql && userId) {
            const stored = await storeJellyfinClientLog(sql, {
                userId,
                deviceId: device?.deviceId || null,
                deviceName: device?.deviceName ?? null,
                clientName,
                clientVersion: device?.clientVersion ?? null,
                text: kept,
                truncated,
            });
            if (!stored.stored) {
                logger.info('Client log not stored as a bundle', {
                    reason: stored.reason,
                    fileName,
                });
            }
        }

        // Jellyfin answers with ClientLogDocumentResponseDto { FileName }.
        return json({ FileName: fileName });
    },
    { pat: 'deny', mode: 'write' },
);
