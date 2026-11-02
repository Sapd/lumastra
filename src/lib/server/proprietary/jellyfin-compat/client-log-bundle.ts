// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Stores a /j ClientLog upload (jellyfin-androidtv sends ACRA crash reports
 * here) as a client_diagnostics log bundle so admins can read it. Goes through
 * ingestLogBundle: feature gate, per-user byte budget, scrubbing, 2 MiB cap and
 * GDPR handling all apply. The eventId is derived from (user, device, sha256 of
 * the text) so ACRA's byte-identical retries collapse onto one row.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type postgres from 'postgres';
import {
    deterministicUuidFrom,
    ingestLogBundle,
} from '$lib/server/services/client-diagnostics/ingest.service';
import { pruneJellyfinBundlesForDevice } from '$lib/server/database/queries/client-diagnostics.queries';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('JellyfinCompat:ClientLog');
export const JELLYFIN_CLIENT_LOG_NAMESPACE = '6d1f3c2e-9b4a-4e57-8a0c-2f5b7e1d4c93';
export const JELLYFIN_BUNDLES_PER_DEVICE = 5;
/** Longest line kept from an upload. Bounds per-line scrub cost: one 256 KiB line used to
 *  stall the event loop; real stack-trace/log lines are far shorter. */
export const MAX_CLIENT_LOG_LINE_CHARS = 2000;
const LINE_TRUNCATION_MARKER = ' …[truncated]';

function capLines(text: string): { text: string; cut: boolean } {
    let cut = false;
    const out = text.split('\n').map((line) => {
        if (line.length <= MAX_CLIENT_LOG_LINE_CHARS) return line;
        cut = true;
        return line.slice(0, MAX_CLIENT_LOG_LINE_CHARS) + LINE_TRUNCATION_MARKER;
    });
    return { text: cut ? out.join('\n') : text, cut };
}

export async function storeJellyfinClientLog(
    sql: postgres.Sql,
    args: {
        userId: string;
        deviceId: string | null;
        deviceName: string | null;
        clientName: string;
        clientVersion: string | null;
        text: string;
        truncated: boolean;
    },
): Promise<{ stored: boolean; reason?: string }> {
    try {
        const capped = capLines(args.text);
        const digest = createHash('sha256').update(args.text).digest('hex');
        const eventId = deterministicUuidFrom(
            JELLYFIN_CLIENT_LOG_NAMESPACE,
            `${args.userId}:${args.deviceId ?? ''}:${digest}`,
        );
        // The sanitised Version can end in '…' (truncation marker) and exceeds the
        // 32-char appVersion limit of the ingest schema.
        const appVersion = args.clientVersion?.replace(/…$/, '').slice(0, 32);
        const result = await ingestLogBundle(
            sql,
            args.userId,
            {
                eventId,
                platform: 'other',
                ...(args.deviceId ? { deviceId: args.deviceId.slice(0, 128) } : {}),
                ...(appVersion ? { appVersion } : {}),
                occurredAt: Date.now(),
                trigger: 'user',
                scope: 'device',
                contentGzipBase64: gzipSync(Buffer.from(capped.text, 'utf8')).toString('base64'),
            },
            {
                trigger: 'client_upload',
                extraPayload: {
                    source: 'jellyfin',
                    clientName: args.clientName,
                    deviceName: args.deviceName,
                    truncated: args.truncated || capped.cut,
                },
            },
        );
        if (!result.ok) return { stored: false, reason: result.reason };
        if (args.deviceId) {
            await pruneJellyfinBundlesForDevice(
                sql,
                args.userId,
                args.deviceId,
                JELLYFIN_BUNDLES_PER_DEVICE,
            );
        }
        return { stored: true };
    } catch (err) {
        logger.warn('Storing Jellyfin client log failed', { error: String(err) });
        return { stored: false, reason: 'error' };
    }
}
