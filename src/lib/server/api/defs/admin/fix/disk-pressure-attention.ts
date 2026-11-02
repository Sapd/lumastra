// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Disk pressure → attention alerts.
 *
 * ## Why this exists
 *
 * A full disk is the single most common way a self-hosted media server dies,
 * and until now nothing in the admin surface reported it: `SystemMetrics` has
 * no disk fields at all, so a volume at 98% left the bell silent and `/admin`
 * green while transcodes started failing. The `/admin/fix/slow` diagnostic
 * answers the question when asked; this makes the same measurement speak
 * unprompted, through the existing attention spine, so it reaches the
 * notification bell and the rolled-up `/admin` verdict.
 *
 * ## NOT YET REGISTERED
 *
 * `src/lib/server/services/attention/adapters.ts` is not owned by the change
 * that added this file, so the adapter is written here and left unwired. To
 * activate it, call `adaptDiskPressure(await readHostPressure())` alongside the
 * other adapters in `deriveAttention` (`attention-service.ts`) and spread the
 * result into the alert list. It is a pure function of a `HostPressure`
 * snapshot and holds no state, so it can be moved into `adapters.ts` verbatim.
 *
 * ## Severity has to be earned
 *
 * A bell that is always non-zero is decoration. Two rules keep this quiet:
 *
 *  1. **Percentage alone is never enough.** 10% free on a 20 TB array is 2 TB —
 *     not a problem. Every threshold here requires a high percentage AND a low
 *     ABSOLUTE amount of free space, because it is the absolute number that
 *     decides whether the next transcode has room.
 *  2. **Critical means "writes are failing now"**, not "getting full". Amber is
 *     the warning; red is reserved for a volume with essentially nothing left.
 *
 * Below those thresholds this emits nothing at all.
 */

import type { DerivedAlert } from '$lib/server/services/attention/types.js';
import type { HostPressure, VolumeUsage } from '$lib/components/admin/fix/host-pressure.schema.js';
// `formatFileSize`, NOT `formatBytes` — the latter is a bandwidth formatter and
// appends "/s", which would render a full disk as "212 MB/s free".
import { formatFileSize } from '$lib/utils/metric-formatters.js';
import * as m from '$lib/paraglide/messages.js';

/** Below this much free space, writes are failing or imminently will. */
const CRITICAL_FREE_BYTES = 256 * 1024 * 1024;

/** "Getting full" floor — one 4K transcode's scratch can consume this. */
const WARNING_FREE_BYTES = 20 * 1024 * 1024 * 1024;

/** Percentage gate, applied ON TOP of the absolute floor (see rule 1 above). */
const WARNING_USED_PERCENT = 90;

/**
 * The `/admin/fix/slow` anchor that shows the same numbers this alert was
 * derived from, so the alert leads to the diagnostic rather than to a dead end.
 */
export const DISK_PRESSURE_SOURCE_REF = '/admin/fix/slow#disk';

type Band = 'critical' | 'low' | null;

/** Classify one volume. Exported so the thresholds are directly testable. */
export function classifyVolume(volume: VolumeUsage): Band {
    // A volume that reports a zero total was not really measured — statfs on
    // some pseudo-filesystems does. Alerting "0 bytes free" on it would be a
    // false red, which is the fastest way to make the bell ignorable.
    if (volume.totalBytes <= 0) return null;
    if (volume.freeBytes < CRITICAL_FREE_BYTES) return 'critical';
    if (volume.freeBytes < WARNING_FREE_BYTES && volume.usedPercent >= WARNING_USED_PERCENT) {
        return 'low';
    }
    return null;
}

/**
 * One alert per volume under pressure. `type` reuses the existing
 * `degraded-component` — a nearly-full volume genuinely IS a degraded component
 * of the server, and `AttentionType` is still a closed enum in Zod and in the
 * generated Swift client, so a new member cannot be added here.
 *
 * That enum is now deprecated. Migration 16.231.0 dropped the Postgres CHECK
 * and added the open `domain` vocabulary that replaces it, so when this adapter
 * is wired up it should declare `domain: 'storage'` (matching
 * `DOMAIN_BY_ATTENTION_TYPE['file-health']`) and keep `degraded-component` only
 * for as long as `type` survives. `DerivedAlert` does not carry `domain` yet —
 * the derivation path adopts it in the same change that starts writing the
 * column.
 */
export function adaptDiskPressure(pressure: HostPressure): DerivedAlert[] {
    const out: DerivedAlert[] = [];

    for (const volume of pressure.volumes) {
        const band = classifyVolume(volume);
        if (band === null) continue;

        const free = formatFileSize(volume.freeBytes);
        const total = formatFileSize(volume.totalBytes);

        out.push({
            // Stable per volume, so ack survives across derive cycles.
            id: `degraded-component:disk:${volume.path}`,
            // The BAND, not the percentage: a 91→92% tick must not evict the
            // operator's acknowledgement, but getting genuinely worse must
            // re-surface the alert.
            fingerprint: band,
            type: 'degraded-component',
            severity: band === 'critical' ? 'critical' : 'warning',
            title:
                band === 'critical'
                    ? m.admin_attention_disk_full_title({ path: volume.label })
                    : m.admin_attention_disk_low_title({ path: volume.label }),
            detail:
                band === 'critical'
                    ? m.admin_attention_disk_full_detail({ free, total })
                    : m.admin_attention_disk_low_detail({
                          free,
                          total,
                          percent: volume.usedPercent,
                      }),
            sourceRef: DISK_PRESSURE_SOURCE_REF,
            term: 'degraded-component',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_disk(),
                    href: DISK_PRESSURE_SOURCE_REF,
                },
            ],
        });
    }

    return out;
}
