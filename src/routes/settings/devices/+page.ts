// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { appPath } from '$lib/shared/api-urls.js';

export const load: PageLoad = () => {
    redirect(307, appPath('/settings/sessions'));
};
