// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/settings/instance-profile.ts
 *
 * POST /api/admin/instance-profile — apply a use-case preset to instance config.
 *
 * When `dryRun: true` the changes are computed but NOT persisted.
 *
 * Re-applying is three-way (reapplyUseCasePreset): only keys the selection
 * change asks to change are written, so settings the admin changed elsewhere
 * survive. `landingPath`: a path overrides, '' asks for the profile's default,
 * absent keeps the current one unless the profile's default changes. Keys an
 * environment variable owns are never written and come back in `envLocked`.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * POST → { applied, primaryMode, landingPath, envLocked, overridden,
 *          libraryTypesNotActivated }                                     (live run)
 *       | { preview: true, diff, primaryMode, landingPath, libraryTypes }  (dry-run;
 *          diff rows may carry overridesChange / envLocked)
 * 422  → validation_failed when useCases or landingPath are invalid
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import {
    saveConfig,
    get as getConfigValue,
    isEnvOverridden,
} from '$lib/server/config/config.service.js';
import { hasEmbeddingProvider } from '$lib/server/config.js';
import { isSonicEngineConfigured } from '$lib/server/services/sonic-embedding.service.js';
import { isValidLandingPath } from '$lib/server/utils/landing-path.js';
import {
    applyUseCasePreset,
    reapplyUseCasePreset,
    schemaBaseline,
    serializeAppliedProfile,
    type UseCaseId,
} from '$lib/config/use-case-presets.js';
import {
    appliedProfileRevision,
    readInstanceProfileState,
} from '$lib/server/config/instance-profile-state.js';
import { ConfigConflictError } from '$lib/server/config/config-conflict.js';
import { ensureLibraryTypeSetting } from '$lib/server/database/queries/library-type-settings.queries.js';
import { getActiveNonEntertainmentLibraries } from '$lib/server/database/queries/library-types.queries.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { NON_ENTERTAINMENT_LIBRARY_TYPES } from '$lib/shared/media-types.js';
// NOTE: _invalidateNonEntLibraryCache lives in the route layout; import directly.
// This is an intentional cross-boundary call — it resets an in-process cache only.
import { _invalidateNonEntLibraryCache } from '../../../../../../routes/+layout.server.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('AdminInstanceProfile');

const VALID_USE_CASES: readonly UseCaseId[] = ['vod', 'music', 'enterprise', 'showcase'];

const InstanceProfileBodySchema = z.object({
    useCases: z.array(z.enum(['vod', 'music', 'enterprise', 'showcase'])),
    landingPath: z.string().optional(),
    dryRun: z.boolean().optional(),
    /**
     * The `at` of the recorded profile the caller's form was built from (null:
     * none recorded). When sent and settings.json no longer holds that record,
     * the apply is refused with 409 instead of overwriting a newer one from
     * another tab, admin or replica. Not checked on a dry run.
     */
    expectedRevision: z.string().nullable().optional(),
});

function sameConfigValue(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
    return a === b;
}

/**
 * Give each non-entertainment library type the profile uses a settings row.
 * Existing rows keep the admin's name, icon, order and visibility; only a type
 * the previous profile did not ask for is shown in the sidebar again. Returns
 * the types that could not be activated (database down or a failed write) so
 * the response does not read as complete.
 */
async function activateLibraryTypes(types: string[], previousTypes: string[]): Promise<string[]> {
    const nonEntTypes = types.filter((t) =>
        (NON_ENTERTAINMENT_LIBRARY_TYPES as readonly string[]).includes(t),
    );
    if (nonEntTypes.length === 0) return [];
    // The config is already saved: a database failure here is reported, not
    // turned into an error response for a change that took effect.
    const sql = await aiDbService.getSql().catch(() => null);
    if (!sql) {
        logger.warn(
            'Library types could not be activated -- DB unavailable; re-applying will retry',
            {
                types: nonEntTypes,
            },
        );
        return nonEntTypes;
    }
    const failed: string[] = [];
    let changed = false;
    for (let i = 0; i < nonEntTypes.length; i++) {
        try {
            const wrote = await ensureLibraryTypeSetting(sql, {
                mediaType: nonEntTypes[i],
                sortOrder: i,
                reveal: !previousTypes.includes(nonEntTypes[i]),
            });
            changed ||= wrote;
        } catch (err) {
            failed.push(nonEntTypes[i]);
            logger.warn(
                'Library type activation failed; config was saved',
                { type: nonEntTypes[i] },
                err instanceof Error ? err : undefined,
            );
        }
    }
    if (changed) _invalidateNonEntLibraryCache();
    return failed;
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: InstanceProfileBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const {
                useCases: rawUseCases,
                landingPath: landingPathOverride,
                dryRun,
                expectedRevision,
            } = ctx.input!.body;

            if (!Array.isArray(rawUseCases)) {
                return ApiProblem.validationFailed('useCases array is required');
            }
            if (!rawUseCases.every((u) => VALID_USE_CASES.includes(u as UseCaseId))) {
                return ApiProblem.validationFailed('Unknown use-case id');
            }
            const selected = [...new Set(rawUseCases as UseCaseId[])];

            const caps = {
                hasEmbeddings: hasEmbeddingProvider(),
                // Same answer the sonic stage's install gate uses: a sidecar URL, or
                // a working subprocess fallback (interpreter, embed.py, torch+msclap).
                hasSonicEmbedder: isSonicEngineConfigured(),
            };

            const effective = (key: string): unknown => {
                const value = getConfigValue(key);
                return value === undefined || value === null ? schemaBaseline(key) : value;
            };
            // The profile that produced today's configuration: the common base
            // for a three-way re-apply (see reapplyUseCasePreset).
            const { previous } = readInstanceProfileState();
            const result = reapplyUseCasePreset(previous, selected, caps, effective);

            // Landing path: an explicit value wins; '' asks for the profile's
            // own default; otherwise it follows the profile only when the
            // profile's default changes, so a landing path the admin set
            // elsewhere survives a re-apply.
            const recomputeLanding =
                landingPathOverride?.trim() === '' || 'INSTANCE_LANDING_PATH' in result.writes;
            let landingPath: string | null = null;
            if (typeof landingPathOverride === 'string' && landingPathOverride.trim() !== '') {
                if (!isValidLandingPath(landingPathOverride)) {
                    return ApiProblem.validationFailed('Invalid landing path');
                }
                landingPath = landingPathOverride;
            } else if (recomputeLanding) {
                landingPath = result.landingPath;
                if (result.primaryMode === 'enterprise') {
                    const sql = await aiDbService.getSql();
                    if (sql) {
                        try {
                            // Admin-scoped endpoint choosing the instance's default
                            // landing path — a deployment-wide setting, not a
                            // per-user view. Unrestricted is stated explicitly so
                            // the decision is greppable rather than a silent omission.
                            const nonEntLibs = await getActiveNonEntertainmentLibraries(
                                sql,
                                unrestrictedAccess(),
                            );
                            const firstVisible = nonEntLibs
                                .slice()
                                .sort((a, b) => a.sort_order - b.sort_order)
                                .find((l) => l.sidebar_visible);
                            if (firstVisible) {
                                landingPath = `/library/${firstVisible.media_type}`;
                            }
                        } catch (err) {
                            logger.warn(
                                'Could not resolve first non-entertainment library for landing path; using preset default',
                                err as object | Error | undefined,
                            );
                        }
                    }
                }
            }

            const wanted: Record<string, string | boolean | string[]> = { ...result.writes };
            delete wanted.INSTANCE_LANDING_PATH;
            if (landingPath !== null) wanted.INSTANCE_LANDING_PATH = landingPath;
            wanted.INSTANCE_USE_CASES = selected;

            // saveConfig never writes a key an environment variable owns. Leave
            // those out of the write and say so, rather than report them applied.
            const envLocked: string[] = [];
            const applied: Record<string, string | boolean | string[]> = {};
            for (const [key, to] of Object.entries(wanted)) {
                if (!isEnvOverridden(key)) applied[key] = to;
                else if (!sameConfigValue(effective(key), to)) envLocked.push(key);
            }
            // An enterprise profile's landing page is the first visible library,
            // not the preset's path, so it differs from the base without anyone
            // having changed it: no "replaces your change" for that one.
            const overridden = result.overrides.filter(
                (key) =>
                    key in applied &&
                    !(key === 'INSTANCE_LANDING_PATH' && previous?.useCases.includes('enterprise')),
            );
            const effectiveLanding =
                'INSTANCE_LANDING_PATH' in applied
                    ? (applied.INSTANCE_LANDING_PATH as string)
                    : String(effective('INSTANCE_LANDING_PATH'));

            if (dryRun === true) {
                const diff: {
                    key: string;
                    from: unknown;
                    to: unknown;
                    overridesChange?: true;
                    newInProfile?: true;
                    envLocked?: true;
                }[] = [];
                for (const [key, to] of Object.entries(wanted)) {
                    const from = effective(key);
                    if (sameConfigValue(from, to)) continue;
                    diff.push({
                        key,
                        from: Array.isArray(to) && !Array.isArray(from) ? [] : from,
                        to,
                        ...(overridden.includes(key) ? { overridesChange: true as const } : {}),
                        ...(result.added.includes(key) ? { newInProfile: true as const } : {}),
                        ...(envLocked.includes(key) ? { envLocked: true as const } : {}),
                    });
                }
                return json({
                    preview: true,
                    diff,
                    primaryMode: result.primaryMode,
                    landingPath: effectiveLanding,
                    libraryTypes: result.libraryTypes,
                });
            }

            // Record what this apply projected (the preset values, not the
            // effective ones): the exact base for the next re-apply, and the
            // revision a stale form is checked against.
            const revision = new Date().toISOString();
            const record = serializeAppliedProfile({
                useCases: selected,
                values: result.patch,
                at: revision,
            });

            // Config first: a refused save must not leave library types
            // activated for a profile that never took effect. The profile's
            // own choices are pinned: dropped for equalling today's default,
            // a later release changing that default would quietly undo them.
            //
            // A form built from an older apply (another tab, admin or replica
            // applied since) is refused rather than overwriting it: the check
            // runs under the save lock against settings.json itself.
            try {
                await saveConfig(
                    { ...applied, INSTANCE_PROFILE_APPLIED: record },
                    {
                        pinKeys: [
                            ...result.requestedKeys,
                            ...(landingPath !== null ? ['INSTANCE_LANDING_PATH'] : []),
                        ],
                        ...(expectedRevision !== undefined
                            ? {
                                  expect: {
                                      key: 'INSTANCE_PROFILE_APPLIED',
                                      test: (fileValue: unknown) =>
                                          appliedProfileRevision(fileValue) === expectedRevision,
                                  },
                              }
                            : {}),
                    },
                );
            } catch (err) {
                if (err instanceof ConfigConflictError) {
                    return ApiProblem.conflict(
                        'The instance profile was applied again since this form was loaded',
                    );
                }
                throw err;
            }
            // A preset rewrites many keys at once; without this row it was
            // invisible in the admin audit log and the change timeline.
            auditLog('settings.save', 'config', auditActor(event), {
                changedKeys: Object.keys(applied),
                source: 'instance-profile',
                useCases: selected,
                ...(envLocked.length > 0 ? { envLocked } : {}),
            });

            const libraryTypesNotActivated = await activateLibraryTypes(
                result.libraryTypes,
                previous === null ? [] : applyUseCasePreset(previous.useCases, caps).libraryTypes,
            );

            return json({
                applied,
                primaryMode: result.primaryMode,
                landingPath: effectiveLanding,
                envLocked,
                overridden,
                libraryTypesNotActivated,
                revision,
            });
        },
    },
});
