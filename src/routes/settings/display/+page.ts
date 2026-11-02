// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { settingsRedirectTarget } from '$lib/config/settings-sections';

export const load: PageLoad = async ({ parent, data }) => {
    const { settingsCtx } = await parent();
    const target = settingsRedirectTarget('display', settingsCtx);
    if (target) redirect(307, target);
    // Forward server-loaded metadata language options so PageData includes them.
    return { metadataLanguages: data.metadataLanguages };
};
