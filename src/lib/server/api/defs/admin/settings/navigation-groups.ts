// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/settings/navigation-groups.ts
 *
 * POST /api/admin/navigation/groups — add a group to NAVIGATION_AVAILABLE_GROUPS
 *
 * Auth: admin.  Surface: internal-only.
 *
 * POST → { availableGroups: string[], persisted: boolean }
 * 409  → conflict when env-locked
 * 422  → validation_failed when group name is invalid or limit exceeded
 * 429  → rate_limited (30/min/user — abuse cap mirrors legacy middleware)
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import {
    saveConfig,
    reloadConfig,
    isEnvOverridden,
    getConfigStorageStatus,
} from '$lib/server/config/config.service.js';
import { config } from '$lib/server/config.js';
import { AddNavGroupBodySchema, NAV_GROUP_MAX_LENGTH } from '$lib/schemas/api-admin-navigation.js';
import {
    checkRateLimit,
    ADMIN_HEAVY_RATE_LIMIT,
} from '$lib/server/middleware/valkey-rate-limit.js';

// ---------------------------------------------------------------------------
// Pure group-management logic (mirrors routes/.../group-service.ts)
// ---------------------------------------------------------------------------

const NAV_GROUP_FILLER_CODEPOINTS = new Set([0x115f, 0x1160, 0x3164, 0xffa0]);
const NAV_GROUP_MAX_COUNT = 250;

function hasUnsafeGroupChars(name: string): boolean {
    if (/\p{C}/u.test(name)) return true;
    if (/[^\S ]/u.test(name)) return true;
    for (const ch of name) {
        const cp = ch.codePointAt(0);
        if (cp !== undefined && NAV_GROUP_FILLER_CODEPOINTS.has(cp)) return true;
    }
    return false;
}

function normalizeGroupName(raw: string): string {
    return raw.normalize('NFC').trim();
}

type AddGroupDecision =
    | { kind: 'add'; group: string; updated: string[] }
    | { kind: 'noop' }
    | { kind: 'invalid' }
    | { kind: 'limit' }
    | { kind: 'env_locked' };

function computeAddGroup(input: {
    raw: string;
    currentNavGroups: string[];
    mergedGroups: string[];
    envLocked: boolean;
}): AddGroupDecision {
    if (input.envLocked) return { kind: 'env_locked' };

    const group = normalizeGroupName(input.raw);
    if (group.length === 0 || group.length > NAV_GROUP_MAX_LENGTH || hasUnsafeGroupChars(group)) {
        return { kind: 'invalid' };
    }

    const navLower = new Set(input.currentNavGroups.map((g) => g.toLowerCase()));
    if (navLower.has(group.toLowerCase())) return { kind: 'noop' };

    if (input.currentNavGroups.length >= NAV_GROUP_MAX_COUNT) return { kind: 'limit' };

    const updated = [...input.currentNavGroups, group];
    return { kind: 'add', group, updated };
}

// ---------------------------------------------------------------------------

function mergedAvailableGroups(): string[] {
    return [
        ...new Set([
            ...config.ADMIN_GROUPS,
            ...config.WATCH_PERMISSION_GROUPS,
            ...config.NAVIGATION_AVAILABLE_GROUPS,
        ]),
    ].filter(Boolean);
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: AddNavGroupBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            // Abuse cap: 30 req/min per user per route (mirrors legacy withAdminHeavyRateLimit).
            const username = event.locals.user?.username ?? 'anonymous';
            const rlKey = `${username}:/api/admin/navigation/groups`;
            const rl = await checkRateLimit(
                rlKey,
                ADMIN_HEAVY_RATE_LIMIT.limit,
                ADMIN_HEAVY_RATE_LIMIT.windowSeconds,
            );
            if (!rl.allowed) {
                return ApiProblem.rateLimited(
                    Math.max(0, rl.resetAt - Math.floor(Date.now() / 1000)),
                );
            }

            const decision = computeAddGroup({
                raw: ctx.input!.body.group,
                currentNavGroups: config.NAVIGATION_AVAILABLE_GROUPS,
                mergedGroups: mergedAvailableGroups(),
                envLocked: isEnvOverridden('NAVIGATION_AVAILABLE_GROUPS'),
            });

            if (decision.kind === 'env_locked') {
                return ApiProblem.conflict(
                    'Available groups are locked by an environment variable',
                );
            }
            if (decision.kind === 'invalid') {
                return ApiProblem.validationFailed('Invalid group name');
            }
            if (decision.kind === 'limit') {
                return ApiProblem.validationFailed('Too many navigation groups configured');
            }

            if (decision.kind === 'add') {
                try {
                    await saveConfig({ NAVIGATION_AVAILABLE_GROUPS: decision.updated });
                } catch {
                    return ApiProblem.internalError('Failed to save group');
                }
                await reloadConfig();
                auditLog('navigation.group.add', 'config', auditActor(event), {
                    group: decision.group,
                });
            }

            const storage = await getConfigStorageStatus();
            return json({
                availableGroups: mergedAvailableGroups(),
                persisted: storage.willPersist,
            });
        },
    },
});
