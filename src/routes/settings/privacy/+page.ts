// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { settingsRedirectTarget } from '$lib/config/settings-sections';

/**
 * The `privacy` section is currently always enabled, so this guard is a no-op
 * today. It exists anyway because every other settings route has one: without it
 * this route is the single entry point that bypasses the shared visibility gate,
 * and the day the section gains a condition, the omission would be a
 * direct-URL hole rather than an obvious missing file.
 */
export const load: PageLoad = async ({ parent }) => {
    const { settingsCtx } = await parent();
    const target = settingsRedirectTarget('privacy', settingsCtx);
    if (target) redirect(307, target);
    return {};
};
