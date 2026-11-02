// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@sveltejs/kit';
import { features } from '$lib/server/config';
import type { PageServerLoad } from './$types';
import { appPath } from '$lib/shared/api-urls.js';

export const load: PageServerLoad = async () => {
    if (!features.personalStats) {
        throw redirect(302, appPath('/'));
    }

    return {};
};
