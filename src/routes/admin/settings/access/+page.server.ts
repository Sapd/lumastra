// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/routes/admin/access/+page.server.ts
//
// Admin-gated loader for the standalone multi-user access control surface.
// Seeds the access-group list server-side.
//
// NOT via an internal `event.fetch` self-request to this app's own API (the
// original shape here, and the pattern `/admin/users/+page.server.ts` and
// `/admin/notifications/+page.server.ts` also used) — that does not work.
// Confirmed via prod logs (while fixing the /admin/notifications instance of
// this same bug): SvelteKit's internal self-fetch for a relative URL does NOT
// carry this app's forward-auth identity headers (USERHEADER/GROUPHEADER)
// onto the synthetic sub-request, so every such self-fetch reaches
// `resolveAuth` with no authentication headers and 401s. The comment this
// replaced ("the session cookie forwards through event.fetch") describes a
// mechanism this app doesn't use — auth here is forward-auth headers, not a
// session cookie, and headers are exactly what does not survive the self-fetch.
//
// Fix: call the same query/mapper the API route handler itself calls,
// directly, in-process — no HTTP hop, no auth boundary to cross. Matches how
// the homepage's own `+page.server.ts` already seeds its data.

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { type AccessGroup } from '$lib/schemas/api-admin-access';
import { config, features } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger';
import {
    loadSettingsForSections,
    loadSearchExposure,
    saveSettingsAction,
    reloadSettingsAction,
} from '$lib/server/admin/settings-helpers';
import { appPath } from '$lib/shared/api-urls.js';
import { getDb } from '$lib/server/database/connection.js';
import { listAccessGroups } from '$lib/server/database/queries/access-groups.queries.js';
import { mapGroupRow } from '$lib/server/api/defs/access/groups/index.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('AdminAccess');

/**
 * Config sections rendered on this page. Must stay in sync with the
 * `/admin/settings/access` entry in `src/lib/config/admin-settings-pages.ts`
 * (the deep-link registry) — its unit test enforces that each section is
 * claimed by exactly one page, but nothing can check that the claiming page
 * actually loads it, so treat the two lists as one edit.
 */
// Must match this page's entry in src/lib/config/admin-settings-pages.ts: a
// section the registry assigns here but this list omits has no editor anywhere
// (`push` was missing, so the push relay settings could not be set in the UI).
const ACCESS_SECTION_IDS = ['groups', 'auth', 'social', 'deviceAuth', 'push', 'network'];

export const load: PageServerLoad = async ({ locals }) => {
    if (!localsIsAdmin(locals)) {
        throw redirect(302, appPath('/'));
    }

    let initialGroups: AccessGroup[] = [];
    const db = getDb();
    if (!db) {
        logger.warn('admin/access load: database unavailable');
    } else {
        try {
            const groups = await listAccessGroups(db);
            initialGroups = groups.map(mapGroupRow);
        } catch (err) {
            logger.warn('admin/access load: failed to seed groups', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Entertainment-specific capabilities are only meaningful when their feature is
    // configured. A training-only instance (requests + live TV off) never sees
    // request/acquisition/live-tv capabilities in the access-group editor.
    //
    // The three config sections that describe WHO may reach this server now render
    // here, next to the in-app group manager they interact with: `groups`
    // (external IdP group → permission mapping), `auth` (built-in login / OIDC /
    // provider selection) and `social` (what users may see about each other).
    // They used to sit on the general settings page, one scroll away from the
    // group editor that gives them meaning.
    //
    // This also covers the "Group-based rules" panel (aggregate audit view of every
    // setting tagged uiHints.groups — see getGroupReferencingSettings):
    // loadSettingsForSections only filters the returned `schema.sections`/
    // `schema.settings` to the given section IDs, NOT `values`/`envOverrides`
    // (those always cover the whole config — see settings-helpers.ts), so the
    // panel's foreign settings (Live TV, player, …) still have their current
    // values here even though their sections are not loaded.
    const settingsData = await loadSettingsForSections(ACCESS_SECTION_IDS);
    const exposure = await loadSearchExposure();

    // Moved here from the Playback page together with the `deviceAuth` section
    // it is about.
    const warnings: string[] = [];
    if (config.FEATURE_DEVICE_AUTH && !config.JWT_SECRET) {
        warnings.push(
            'Public API is enabled but JWT_SECRET is not set. Add JWT_SECRET to your environment variables. Generate one with: openssl rand -hex 32',
        );
    }

    return {
        ...settingsData,
        ...exposure,
        warnings,
        initialGroups,
        capabilityFlags: {
            requests: features.requests,
            liveTv: config.FEATURE_LIVETV,
            mediaManagement: features.requests, // *arr-backed acquisition lives behind the request pipeline
        },
    };
};

export const actions: Actions = {
    save: async ({ request, locals }) => saveSettingsAction(request, locals),
    reload: async ({ locals }) => reloadSettingsAction(locals),
};
