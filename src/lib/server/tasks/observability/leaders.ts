// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// leaders.ts — resource-class leader registry reader (Slice 0).
//
// The orchestrator holds one leader lock per resource class at
// `lock:orch:<class>` (SET NX PX, renewed). This reader exposes who holds each
// of the 7 class locks RIGHT NOW for the admin UI — there is no reader today.
//
// NEVER SCAN. We GET over the static RESOURCE_CLASSES list (7 keys), reading the
// holder value (`<instanceId>:<bootId>`) and PTTL for each.

import { RESOURCE_CLASSES } from '@sapd/lumastra-plugin-sdk';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { ClassLeader } from '$lib/schemas/task-system-observability.schema.js';

const log = Logger.for('LeaderRegistry');

const LOCK_PREFIX = 'lock:orch:';

/**
 * Read the current leader for each of the 7 resource classes. Best-effort: a
 * Valkey failure yields `{ holderInstanceId: null, ttlMs: null }` for every
 * class rather than throwing.
 *
 * `holderInstanceId` is the instance-id portion of the lock value
 * (`<instanceId>:<bootId>`); `heldByThisReplica` compares it to this process's
 * configured instance id.
 */
export async function readClassLeaders(): Promise<ClassLeader[]> {
    const client = getCoordinationClient();
    const myInstanceId = config.INSTANCE_ID;

    return Promise.all(
        RESOURCE_CLASSES.map(async (resourceClass): Promise<ClassLeader> => {
            if (!client) {
                return {
                    resourceClass,
                    holderInstanceId: null,
                    heldByThisReplica: false,
                    ttlMs: null,
                };
            }
            const key = `${LOCK_PREFIX}${resourceClass}`;
            let holder: string | null = null;
            let ttlMs: number | null = null;
            try {
                holder = glideToString(await client.customCommand(['GET', key]));
                const pttl = Number(await client.customCommand(['PTTL', key]));
                // PTTL returns -2 (no key) / -1 (no expiry); both → null here.
                ttlMs = Number.isFinite(pttl) && pttl >= 0 ? pttl : null;
            } catch (err) {
                log.warn('readClassLeaders: GET/PTTL failed', {
                    resourceClass,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
            // Holder value is `<instanceId>:<bootId>` — take the instance-id part.
            const holderInstanceId = holder ? holder.split(':')[0] : null;
            return {
                resourceClass,
                holderInstanceId,
                heldByThisReplica: holderInstanceId === myInstanceId,
                ttlMs,
            };
        }),
    );
}

function glideToString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (value instanceof Uint8Array || value instanceof Buffer) {
        return Buffer.from(value).toString('utf-8');
    }
    return null;
}
