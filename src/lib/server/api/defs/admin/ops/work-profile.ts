// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/ops/work-profile — "how hard should Lumastra work?" (Gentle/Balanced/
 * Fast), one question mapping to the `LUMASTRA_CONCURRENCY_*` knobs instead of
 * asking an operator to reason about them directly.
 *
 * GET /api/admin/ops/work-profile → current profile + what each preset means
 *                                    for this host's detected core count.
 * PUT /api/admin/ops/work-profile → apply a preset.
 *
 * Only scales `cpu`, `io`, and `ingest` — the three concurrency classes whose
 * OWN schema.ts descriptions say more slots helps on a bigger/more-dedicated
 * host. `embedding`, `bulk`, `discovery` (API-rate-limited: "more slots burn
 * wallclock, not throughput") and `maintenance`/`analysis` (periodic, or
 * already fanning out internally per run) are left at their default across
 * every profile — scaling them would contradict the reasoning already
 * documented for those settings, not honor it.
 *
 * IMPORTANT — this does NOT take effect live. Every `LUMASTRA_CONCURRENCY_*`
 * setting is `requiresRestart: true` (schema.ts): the task runner reads them
 * once at process start. This endpoint always reports `requiresRestart: true`
 * and the UI must say so plainly — the prior finding that motivated this
 * comment is that a "use fewer workers" dial with no restart notice silently
 * does nothing, which is worse than not shipping the control at all.
 *
 * Auth: admin. Errors: problem+json.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { problem } from '$lib/server/api/problem.js';
import { get as getConfigValue, saveConfig, configSchema } from '$lib/server/config/index.js';
import { getDefaultValues, type SettingDefinition } from '$lib/config/schema.js';
import { getCpuBudgetCores } from '$lib/server/utils/cpu-budget.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

const WORK_PROFILES = ['gentle', 'balanced', 'fast'] as const;
type WorkProfile = (typeof WORK_PROFILES)[number];

/** The only classes a profile scales — see module doc for why the rest don't. */
const SCALED_KEYS = [
    'LUMASTRA_CONCURRENCY_CPU',
    'LUMASTRA_CONCURRENCY_IO',
    'LUMASTRA_CONCURRENCY_INGEST',
] as const;
type ScaledKey = (typeof SCALED_KEYS)[number];

const PROFILE_MULTIPLIER: Record<WorkProfile, number> = {
    gentle: 0.5,
    balanced: 1,
    fast: 2,
};

function settingFor(key: ScaledKey): SettingDefinition {
    const setting = configSchema.find((s) => s.key === key);
    if (!setting) throw new Error(`Unknown setting: ${key}`);
    return setting;
}

/**
 * Concrete concurrency values a profile resolves to on THIS host — the
 * "balanced" baseline is the existing cgroup-aware default
 * (`getDefaultValues`), scaled and clamped to each setting's own min/max so a
 * preset can never write an out-of-range value.
 */
export function resolveProfile(profile: WorkProfile, cpuCores: number): Record<ScaledKey, number> {
    const balanced = getDefaultValues({ cpuCores });
    const multiplier = PROFILE_MULTIPLIER[profile];
    const out = {} as Record<ScaledKey, number>;
    for (const key of SCALED_KEYS) {
        const setting = settingFor(key);
        const base = Number(balanced[key]) || 1;
        const scaled = Math.round(base * multiplier);
        const min = setting.validation?.min ?? 1;
        const max = setting.validation?.max ?? scaled;
        out[key] = Math.max(min, Math.min(max, scaled));
    }
    return out;
}

function currentProfile(): WorkProfile {
    const raw = getConfigValue<string>('LUMASTRA_WORK_PROFILE');
    return (WORK_PROFILES as readonly string[]).includes(raw) ? (raw as WorkProfile) : 'balanced';
}

const WorkProfileBody = z.object({
    profile: z.enum(WORK_PROFILES),
});

function buildStatus(profile: WorkProfile, cpuCores: number) {
    return {
        profile,
        cpuCores,
        requiresRestart: true,
        concurrency: resolveProfile(profile, cpuCores),
        presets: Object.fromEntries(
            WORK_PROFILES.map((p) => [p, resolveProfile(p, cpuCores)]),
        ) as Record<WorkProfile, Record<ScaledKey, number>>,
    };
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            const cpuCores = getCpuBudgetCores();
            return json(buildStatus(currentProfile(), cpuCores), {
                headers: { 'Cache-Control': 'no-store' },
            });
        },

        PUT: async (event, _ctx) => {
            let rawBody: unknown;
            try {
                rawBody = await readBoundedJson(event.request);
            } catch {
                rawBody = {};
            }
            const parsed = WorkProfileBody.safeParse(rawBody);
            if (!parsed.success) {
                return problem('validation_failed', {
                    error: 'Invalid work profile request',
                    details: parsed.error.issues.map((i) => ({
                        field: i.path.join('.') || 'body',
                        message: i.message,
                    })),
                });
            }

            const { profile } = parsed.data;
            const cpuCores = getCpuBudgetCores();
            const concurrency = resolveProfile(profile, cpuCores);

            await saveConfig({
                LUMASTRA_WORK_PROFILE: profile,
                ...concurrency,
            });

            // Security fix C24 (2026-09-16): auditActor(event) resolves the
            // USERNAME (principal.username), not the users.id UUID the
            // hand-built object below used to pass as `username` — a UUID
            // actor can never be reached by the GDPR erasure predicate,
            // which matches on `LOWER(actor) = <username>`.
            auditLog('config.work-profile.set', 'work-profile', auditActor(event), {
                profile,
                concurrency,
            });

            return json(buildStatus(profile, cpuCores));
        },
    },
});
