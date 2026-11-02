// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The overall verdict of the System → Health page, from every input it reads.
 *
 * Precedence: critical > degraded > unknown > healthy. A known problem always
 * shows, whatever else is missing: incomplete data can only turn "healthy" into
 * "unknown" ("check incomplete"), never hide a failing database behind
 * "unknown", and a failing component or an unhealthy task system is critical —
 * not just degraded because the attention board had not flagged it yet.
 */

export type OverallHealthVerdict = 'critical' | 'degraded' | 'unknown' | 'healthy';

export interface OverallHealthInputs {
    /** Attention-board verdict; 'unknown' when the board was unavailable. */
    attention: 'healthy' | 'degraded' | 'critical' | 'unknown';
    /** Component-health statuses; `undefined` = a component that could not be read. */
    components: ReadonlyArray<'pass' | 'warn' | 'fail' | undefined>;
    /** Task-system observability rollup, `null` when it could not be fetched. */
    taskSystem: 'healthy' | 'degraded' | 'unhealthy' | 'unknown' | null;
    /** Some input could not be fetched or is still loading. */
    incomplete: boolean;
}

export function overallHealthVerdict(i: OverallHealthInputs): OverallHealthVerdict {
    if (
        i.attention === 'critical' ||
        i.components.some((s) => s === 'fail') ||
        i.taskSystem === 'unhealthy'
    ) {
        return 'critical';
    }
    if (
        i.attention === 'degraded' ||
        i.components.some((s) => s === 'warn') ||
        i.taskSystem === 'degraded'
    ) {
        return 'degraded';
    }
    if (
        i.incomplete ||
        i.attention === 'unknown' ||
        i.taskSystem === null ||
        i.taskSystem === 'unknown' ||
        i.components.length === 0 ||
        i.components.some((s) => s === undefined)
    ) {
        return 'unknown';
    }
    return 'healthy';
}
