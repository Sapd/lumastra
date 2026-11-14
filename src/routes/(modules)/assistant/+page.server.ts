// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AI Assistant page server load function
 *
 * Age-restricted profiles are redirected to /browse as they should not access AI assistant.
 */

import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { appPath } from '$lib/shared/api-urls.js';

export const load: PageServerLoad = async ({ locals }) => {
    // Age-restricted profiles cannot access AI assistant
    if (locals.user?.isAgeRestricted) {
        throw redirect(302, appPath('/browse'));
    }

    return {};
};
