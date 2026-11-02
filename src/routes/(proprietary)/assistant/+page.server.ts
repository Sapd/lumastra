// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * AI Assistant page server load function
 *
 * Age-restricted profiles are redirected to /browse as they should not access AI assistant.
 */

import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { requireModuleOrRedirect } from '$lib/server/proprietary/licensing/module-gate.js';
import { appPath } from '$lib/shared/api-urls.js';

export const load: PageServerLoad = async ({ locals }) => {
    // License gate (defense-in-depth, mirrors the LMS/showcase admin pages): dark the page
    // when the 'ai_assistant' module isn't licensed under enforcement. The /api/assistant
    // endpoint is independently gated; this stops the shell rendering for an unlicensed module.
    await requireModuleOrRedirect('ai_assistant', '/');

    // Age-restricted profiles cannot access AI assistant
    if (locals.user?.isAgeRestricted) {
        throw redirect(302, appPath('/browse'));
    }

    return {};
};
