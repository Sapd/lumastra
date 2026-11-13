// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/admin/settings-helpers.ts
import { fail } from '@sveltejs/kit';
import type { ActionFailure } from '@sveltejs/kit';
import {
    getConfigForAdmin,
    initConfigService,
    saveConfig,
    reloadConfig,
    getConfigPath,
    getConfigStorageStatus,
    getAll,
    isSensitiveKey,
    isEnvOverridden,
    getPendingRestartKeys,
    type ConfigValues,
    type ConfigStorageStatus,
} from '$lib/server/config/index.js';
import { configSchema, type SectionDefinition, type SettingDefinition } from '$lib/config/schema';
import { devFeaturesEnabled, privateModulesBuildEnabled } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger';
import { isRecord } from '$lib/utils/data-extraction';
import { auditLog, auditActorFromLocals } from '$lib/server/utils/audit-log';
import { loadProviderSearchIndex } from '$lib/server/admin/provider-search-index';
import type { ProviderSearchEntry } from '$lib/utils/admin/settings-search';
import { SECRET_CONFIGURED_SENTINEL } from '$lib/shared/secret-sentinel';
import { planSettingsUpdates, commitSettingsUpdates } from './settings-write.js';

import {
    validateApnsSettings,
    apnsAdminStatus,
    type ApnsAdminStatus,
} from '$lib/server/services/push/apns-credential.js';

const logger = Logger.for('AdminSettings');
const PRIVATE_MODULES_SECTION_ID = 'modules';

function filterPrivateBuildSections<T extends { id: string }>(sections: T[]): T[] {
    if (privateModulesBuildEnabled) return sections;
    return sections.filter((section) => section.id !== PRIVATE_MODULES_SECTION_ID);
}

function filterPrivateBuildSettings<T extends { section: string }>(settings: T[]): T[] {
    if (privateModulesBuildEnabled) return settings;
    return settings.filter((setting) => setting.section !== PRIVATE_MODULES_SECTION_ID);
}

export interface SettingsLoadResult {
    apnsStatus?: ApnsAdminStatus;
    values: ConfigValues;
    envOverrides: string[];
    /** Keys saved in settings.json (an ENV-locked key here has a file copy too). */
    configFileKeys: string[];
    /** Restart-only settings saved with a new value this process has not applied yet. */
    restartPendingKeys: string[];
    schema: { sections: SectionDefinition[]; settings: SettingDefinition[] };
    configPath: string;
    storageStatus: ConfigStorageStatus;
    /** Exposes dev-only settings in the admin UI (true on dev/preprod). */
    devFeaturesEnabled: boolean;
}

/**
 * Replace every stored secret (`uiHints.sensitive`) with the sentinel before
 * the values reach the browser. The settings pages only need to know that a
 * secret IS stored; shipping the decrypted value put every API key of every
 * section into each settings page's data. An unset secret stays '' so the UI
 * can say "not set".
 */
export function maskSensitiveValues(values: ConfigValues): ConfigValues {
    const out: ConfigValues = {};
    for (const [key, value] of Object.entries(values)) {
        out[key] =
            isSensitiveKey(key) && typeof value === 'string' && value !== ''
                ? SECRET_CONFIGURED_SENTINEL
                : value;
    }
    return out;
}

/**
 * Load config data filtered to specific section IDs.
 * Initializes the config service if not yet ready.
 */
export async function loadSettingsForSections(sectionIds: string[]): Promise<SettingsLoadResult> {
    let configData: ReturnType<typeof getConfigForAdmin>;
    try {
        configData = getConfigForAdmin();
    } catch (error) {
        logger.warn('Config service not initialized, reloading', { error });
        await initConfigService();
        configData = getConfigForAdmin();
    }

    const sectionIdSet = new Set(sectionIds);
    const filteredSections = filterPrivateBuildSections(
        configData.schema.sections.filter((s) => sectionIdSet.has(s.id)),
    );
    const filteredSettings = filterPrivateBuildSettings(
        configData.schema.settings.filter((s) => sectionIdSet.has(s.section)),
    );

    return {
        values: maskSensitiveValues(configData.values),
        ...(sectionIdSet.has('push') ? { apnsStatus: apnsAdminStatus(configData.values) } : {}),
        envOverrides: configData.envOverrides,
        configFileKeys: configData.fileKeys,
        restartPendingKeys: getPendingRestartKeys(),
        schema: { sections: filteredSections, settings: filteredSettings },
        configPath: getConfigPath(),
        storageStatus: await getConfigStorageStatus(),
        devFeaturesEnabled,
    };
}

/**
 * Load ALL config sections (unfiltered) for global search.
 * Returns only the schema (sections + settings), not values.
 */
export function loadAllSectionsForSearch(): {
    sections: SectionDefinition[];
    settings: SettingDefinition[];
} {
    let configData: ReturnType<typeof getConfigForAdmin>;
    try {
        configData = getConfigForAdmin();
    } catch (error) {
        logger.warn('Failed to load sections for global search', { error });
        return { sections: [], settings: [] };
    }
    return {
        sections: filterPrivateBuildSections(configData.schema.sections),
        settings: filterPrivateBuildSettings(configData.schema.settings),
    };
}

/**
 * Bundle the data every settings-page search box needs: all sections (for
 * cross-page setting matches) and the provider index (for provider-name search).
 */
export async function loadSearchExposure(): Promise<{
    allSections: { sections: SectionDefinition[]; settings: SettingDefinition[] };
    providerIndex: ProviderSearchEntry[];
}> {
    return {
        allSections: loadAllSectionsForSearch(),
        providerIndex: await loadProviderSearchIndex(),
    };
}

/**
 * NOT `ReturnType<typeof fail>`: `fail` is overloaded, so `ReturnType` picks the
 * generic overload and yields `ActionFailure<unknown>`. SvelteKit's generated
 * `ActionData` unwraps the payload out of `ActionFailure`, so that `unknown`
 * swallowed the whole union and every consuming page saw `ActionData = {}` —
 * making `form.error` / `form.success` a type error on each one. Naming the
 * payload keeps the union intact.
 */
type SettingsActionFailure = ActionFailure<{ error: string }>;

import { denyUnlessAdmin, type AdminActionLocals } from './admin-action-gate.js';

/**
 * Shared form action: parse updates JSON from form data and save to config file.
 */
export async function saveSettingsAction(
    request: Request,
    locals: AdminActionLocals | null | undefined,
): Promise<{ success: true } | SettingsActionFailure> {
    // Actions run before the /admin layout load — gate here, always first.
    const denied = denyUnlessAdmin(locals);
    if (denied) return denied;
    try {
        const formData = await request.formData();
        const updatesJson = formData.get('updates');

        if (!updatesJson || typeof updatesJson !== 'string') {
            return fail(400, { error: 'Missing updates data' });
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(updatesJson);
        } catch {
            return fail(400, { error: 'Invalid updates data' });
        }
        if (!isRecord(parsed)) {
            return fail(400, { error: 'Invalid updates data' });
        }

        // The page posts only the keys the operator changed. The sentinel means
        // "keep the stored secret" and must never be written; a value equal to
        // the current one is not a change either — the audit log should name
        // what actually changed. Shared with the setup wizard's connection
        // endpoints (settings-write.ts).
        const { updates, envLocked } = planSettingsUpdates(parsed);
        // saveConfig never writes an ENV-owned key, so a changed value for one
        // used to come back as "saved" (and be audited) while the environment
        // kept winning. Refuse the whole save before anything is written.
        if (envLocked.length > 0) {
            return fail(409, {
                error: `Set by an environment variable, remove it to change this here: ${envLocked.join(', ')}`,
            });
        }

        // Parsed before the first write: a malformed list used to throw after
        // the updates were already saved, reporting a failed save that had
        // half happened.
        const persistJson = formData.get('persistEnv');
        let persistKeys: unknown;
        try {
            persistKeys =
                typeof persistJson === 'string' && persistJson ? JSON.parse(persistJson) : [];
        } catch {
            return fail(400, { error: 'Invalid persistEnv data' });
        }

        const apnsSubmitted =
            Object.keys(parsed).some((key) => key.startsWith('APNS_')) ||
            (Array.isArray(persistKeys) &&
                persistKeys.some(
                    (key: unknown) => typeof key === 'string' && key.startsWith('APNS_'),
                ));
        if (apnsSubmitted) {
            const candidate = validateApnsSettings({ ...getAll(), ...updates });
            if (candidate.kind === 'invalid') return fail(400, { error: candidate.reason });
        }

        logger.info('Saving config updates', {
            keyCount: Object.keys(updates).length,
        });

        if (Object.keys(updates).length > 0) {
            await commitSettingsUpdates(updates, locals ?? {});
            logger.info('Config saved successfully');
        }

        // "Save to config" on ENV-locked settings: copy the environment's value
        // into settings.json so it survives removing the variable. Only key
        // names come from the browser — the value is read here, so a secret
        // never makes the round trip. Keys the environment does not own are
        // ignored (there is nothing to copy).
        const persist: ConfigValues = {};
        const current = getAll();
        if (Array.isArray(persistKeys)) {
            for (const key of persistKeys) {
                // Env-only keys have no settings.json copy (saveConfig skips them).
                if (
                    typeof key === 'string' &&
                    isEnvOverridden(key) &&
                    !configSchema.some((s) => s.key === key && s.envOnlyEnforced)
                ) {
                    persist[key] = current[key];
                }
            }
        }
        if (Object.keys(persist).length > 0) {
            await saveConfig(persist, { persistEnvOverridden: true });
            auditLog('settings.persist_env', 'config', auditActorFromLocals(locals ?? {}), {
                changedKeys: Object.keys(persist),
            });
        }

        return { success: true };
    } catch (error) {
        logger.error('Failed to save config', error as Error);
        return fail(500, { error: (error as Error).message });
    }
}

/**
 * Shared form action: reload config from file.
 */
export async function reloadSettingsAction(
    locals: AdminActionLocals | null | undefined,
): Promise<{ success: true; reloaded: true } | SettingsActionFailure> {
    const denied = denyUnlessAdmin(locals);
    if (denied) return denied;
    try {
        logger.info('Reloading config from file');
        await reloadConfig();
        logger.info('Config reloaded successfully');
        return { success: true, reloaded: true };
    } catch (error) {
        logger.error('Failed to reload config', error as Error);
        return fail(500, { error: (error as Error).message });
    }
}

/**
 * Factory that creates a standard settings page server module.
 * Handles the common load + actions pattern shared by all settings pages.
 *
 * @param sectionIds - Config section IDs to load
 * @param augment - Optional function to add extra data to the load result
 */
export function createSettingsPageServer<T extends Record<string, unknown>>(
    sectionIds: string[],
    augment?: (data: SettingsLoadResult) => T,
): {
    load: () => Promise<
        SettingsLoadResult &
            Awaited<ReturnType<typeof loadSearchExposure>> & { warnings: string[] } & T
    >;
    actions: {
        save: ({
            request,
            locals,
        }: {
            request: Request;
            locals: AdminActionLocals;
        }) => ReturnType<typeof saveSettingsAction>;
        reload: ({
            locals,
        }: {
            locals: AdminActionLocals;
        }) => ReturnType<typeof reloadSettingsAction>;
    };
} {
    return {
        load: async () => {
            const data = await loadSettingsForSections(sectionIds);
            const exposure = await loadSearchExposure();
            const extra = augment ? augment(data) : ({} as T);
            return { ...data, ...exposure, warnings: [] as string[], ...extra };
        },
        actions: {
            save: ({ request, locals }: { request: Request; locals: AdminActionLocals }) =>
                saveSettingsAction(request, locals),
            reload: ({ locals }: { locals: AdminActionLocals }) => reloadSettingsAction(locals),
        },
    };
}
