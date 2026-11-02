// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/routes/admin/settings/appearance/+page.server.ts
//
// Settings → Appearance: the theming-engine admin panel. Owns the four
// `branding`-section config keys that are hidden from the generic settings
// grid (see uiHints.hidden in $lib/config/schema.ts) because they need
// dedicated editors, not generic string/color inputs:
//   - APPEARANCE_DEFAULT_THEME  (string — an enabled theme id)
//   - APPEARANCE_CUSTOM_THEMES  (JSON array of ThemeDefinition)
//   - APPEARANCE_CUSTOM_CSS     (string — raw CSS)
//   - APPEARANCE_CUSTOM_JS      (string — raw JS, admin-trust feature)
//
// Unlike the generic `saveSettingsAction` (which persists whatever JSON blob
// it's handed with no domain validation), this page's `save` action
// validates APPEARANCE_CUSTOM_THEMES per-entry against ThemeDefinitionSchema
// and rejects APPEARANCE_DEFAULT_THEME unless it names an enabled id —
// exactly the two invariants getEnabledThemes() otherwise only enforces
// silently (drop + log) at read time. Here the admin is actively editing, so
// a rejected save with an actionable error is correct instead of a silent
// drop.
import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { denyUnlessAdmin } from '$lib/server/admin/admin-action-gate.js';
import { loadSettingsForSections } from '$lib/server/admin/settings-helpers';
import { saveConfig, isEnvOverridden } from '$lib/server/config/index.js';
import { getEnabledThemes } from '$lib/server/theme/enabled-themes.js';
import { ThemeDefinitionSchema } from '$lib/schemas/theme';
import { BUILTIN_THEMES } from '$lib/shared/theme/theme-model';
import { isRecord } from '$lib/utils/data-extraction';
import { Logger } from '$lib/server/utils/logger';
import { auditLog, auditActorFromLocals } from '$lib/server/utils/audit-log';
import * as m from '$lib/paraglide/messages.js';

const logger = Logger.for('AdminAppearance');
const BUILTIN_IDS = new Set(BUILTIN_THEMES.map((t) => t.id));
/** The only keys this page's action may write. */
const APPEARANCE_KEYS = new Set([
    'APPEARANCE_DEFAULT_THEME',
    'APPEARANCE_CUSTOM_THEMES',
    'APPEARANCE_CUSTOM_CSS',
    'APPEARANCE_CUSTOM_JS',
]);

export const load: PageServerLoad = async () => {
    const settingsData = await loadSettingsForSections(['branding']);
    return {
        ...settingsData,
        warnings: [] as string[],
        // Builtins + currently-valid persisted customs, for the default-theme
        // picker's initial option list (the client also folds in-progress
        // custom-theme edits on top of this — see +page.svelte).
        enabledThemes: getEnabledThemes(),
    };
};

// `satisfies` rather than `: Actions` — the annotation ERASES the per-action
// return types, which collapses the generated `ActionData` to `{}` and makes
// every `form.<field>` read in the page a type error. `satisfies` keeps the
// same constraint check AND the inference.
export const actions = {
    save: async ({ request, locals }) => {
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
            // This action validates themes and then writes the payload as is, so
            // it must not double as a writer for any other setting.
            const foreign = Object.keys(parsed).filter((key) => !APPEARANCE_KEYS.has(key));
            if (foreign.length > 0) {
                return fail(400, { error: `Not an appearance setting: ${foreign.join(', ')}` });
            }
            // saveConfig skips ENV-owned keys; answering "saved" for them was a lie.
            const locked = Object.keys(parsed).filter((key) => isEnvOverridden(key));
            if (locked.length > 0) {
                return fail(409, {
                    error: `Set by an environment variable, remove it to change this here: ${locked.join(', ')}`,
                });
            }

            // Validate custom themes, if this save touches them: every entry must
            // pass the shared Zod schema, may not shadow a builtin id, and ids must
            // be unique within the payload.
            let customThemeIds: string[] | null = null;
            if ('APPEARANCE_CUSTOM_THEMES' in parsed) {
                const rawThemes = parsed.APPEARANCE_CUSTOM_THEMES;
                if (!Array.isArray(rawThemes)) {
                    return fail(400, { error: m.admin_appearance_invalid_theme() });
                }
                const seenIds = new Set<string>();
                for (const entry of rawThemes) {
                    const result = ThemeDefinitionSchema.safeParse(entry);
                    if (
                        !result.success ||
                        BUILTIN_IDS.has(result.data.id) ||
                        seenIds.has(result.data.id)
                    ) {
                        return fail(400, { error: m.admin_appearance_invalid_theme() });
                    }
                    seenIds.add(result.data.id);
                }
                customThemeIds = [...seenIds];
            }

            // Validate the default theme id, if this save touches it: it must
            // resolve to an enabled theme — a builtin, or a custom id that is
            // ALSO present in this same payload (so setting a brand-new custom
            // theme as default in one save works), falling back to the
            // currently-persisted customs when this save doesn't touch
            // APPEARANCE_CUSTOM_THEMES at all.
            if ('APPEARANCE_DEFAULT_THEME' in parsed) {
                const defaultTheme = parsed.APPEARANCE_DEFAULT_THEME;
                if (typeof defaultTheme !== 'string') {
                    return fail(400, { error: m.admin_appearance_invalid_theme() });
                }
                const enabledIds = new Set([
                    ...BUILTIN_IDS,
                    ...(customThemeIds ?? getEnabledThemes().map((t) => t.id)),
                ]);
                if (!enabledIds.has(defaultTheme)) {
                    return fail(400, { error: m.admin_appearance_invalid_theme() });
                }
            }

            logger.info('Saving appearance config updates', {
                keyCount: Object.keys(parsed).length,
            });

            await saveConfig(parsed);

            auditLog('settings.save', 'config', auditActorFromLocals(locals), {
                changedKeys: Object.keys(parsed),
            });

            return { success: true };
        } catch (error) {
            logger.error('Failed to save appearance settings', error as Error);
            return fail(500, { error: (error as Error).message });
        }
    },
} satisfies Actions;
