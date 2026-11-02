// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { config } from '$lib/server/config.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    adminExistsIgnoringSetupLock,
    isSetupLocked,
} from '$lib/server/database/queries/users.queries.js';
import { appPath } from '$lib/shared/api-urls.js';

/**
 * "Setup is locked" (security review 6, ruling S-C5c-2): shown only while
 * first-run setup has completed (the lock row exists) and no admin can be
 * found. Static text, no data: anyone who reaches /setup on such an install
 * lands here. Unlocked installs go to the wizard, installs with an admin go
 * home, and a read error fails inert (home), like /setup itself.
 */
export const load: PageServerLoad = async () => {
    const sql = await aiDbService.getSql();
    let locked: boolean;
    let adminFound: boolean;
    try {
        if (!sql) throw new Error('database unavailable');
        locked = await isSetupLocked(sql);
        adminFound = locked && (await adminExistsIgnoringSetupLock(sql, config.ADMIN_GROUPS));
    } catch {
        throw redirect(303, appPath('/'));
    }
    if (!locked) throw redirect(303, appPath('/setup'));
    if (adminFound) throw redirect(303, appPath('/'));
    return {};
};
