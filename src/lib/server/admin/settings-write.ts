// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one write path for operator-entered settings.
 *
 * The admin settings form action (`saveSettingsAction`) and the first-run
 * wizard's connection endpoints both store settings an operator typed in. They
 * must agree on what a "change" is (the masked-secret sentinel and an unchanged
 * value are not), on refusing a key an environment variable owns (saveConfig
 * skips it silently, which used to report "saved" while the env kept winning),
 * and on the audit entry. Two copies of that is how one of them drifts.
 */

import {
    saveConfig,
    getAll,
    isEnvOverridden,
    type ConfigValues,
} from '$lib/server/config/index.js';
import { auditLog, auditActorFromLocals } from '$lib/server/utils/audit-log';
import { isSecretSentinel } from '$lib/shared/secret-sentinel';
import { settingValueEqual } from '$lib/utils/admin/setting-value-equal';

export interface SettingsUpdatePlan {
    /** Keys whose value actually changes, ready for {@link commitSettingsUpdates}. */
    updates: ConfigValues;
    /** Keys that would change but are owned by an environment variable. */
    envLocked: string[];
}

/**
 * Work out what a submitted set of values would change, without writing.
 *
 * Callers refuse the whole save when `envLocked` is non-empty, before anything
 * is written.
 */
export function planSettingsUpdates(submitted: Record<string, unknown>): SettingsUpdatePlan {
    const current = getAll();
    const updates: ConfigValues = {};
    const envLocked: string[] = [];
    for (const [key, value] of Object.entries(submitted)) {
        if (isSecretSentinel(value)) continue;
        if (settingValueEqual(value, current[key])) continue;
        if (isEnvOverridden(key)) {
            envLocked.push(key);
            continue;
        }
        updates[key] = value as ConfigValues[string];
    }
    // Contact with lumastra.org switched back on: the weekly check-in comes back
    // on with it (its default), unless this same save changes it explicitly.
    if (
        updates.LICENSE_SERVER_CONTACT_ENABLED === true &&
        !('LICENSE_CHECK_IN_ENABLED' in updates) &&
        current.LICENSE_CHECK_IN_ENABLED === false &&
        !isEnvOverridden('LICENSE_CHECK_IN_ENABLED')
    ) {
        updates.LICENSE_CHECK_IN_ENABLED = true;
    }
    return { updates, envLocked };
}

/** Persist a plan's updates and audit the changed key names (never values). */
export async function commitSettingsUpdates(
    updates: ConfigValues,
    locals: Parameters<typeof auditActorFromLocals>[0],
): Promise<void> {
    if (Object.keys(updates).length === 0) return;
    // A saved licence-contact switch is an answer to "contact lumastra.org?",
    // kept even when it is the default (on): a new install's first call to the
    // licensing server waits for that answer (license-refresh.ts).
    if ('LICENSE_SERVER_CONTACT_ENABLED' in updates) {
        await saveConfig(updates, { pinKeys: ['LICENSE_SERVER_CONTACT_ENABLED'] });
    } else {
        await saveConfig(updates);
    }
    auditLog('settings.save', 'config', auditActorFromLocals(locals), {
        changedKeys: Object.keys(updates),
    });
}
