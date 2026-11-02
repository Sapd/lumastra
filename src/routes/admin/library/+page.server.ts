// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { appPath } from '$lib/shared/api-urls.js';

/**
 * Section index (admin IA redesign, spec §4: "the FIRST page is the section
 * landing"). `/admin/library` has no content of its own — it forwards to the
 * section's first nav page (Media).
 */
export const load: PageServerLoad = () => {
    throw redirect(307, appPath('/admin/library/media'));
};
