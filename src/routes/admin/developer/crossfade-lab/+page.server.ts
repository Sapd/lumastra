// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { requireDevTools } from '$lib/server/admin/require-dev-tools.js';

// Admin gating already happens in src/routes/admin/+layout.server.ts (isAdmin
// check). This debug page is entirely client-driven — no server data needed
// beyond the Developer-section gate.
export const load: PageServerLoad = async () => {
    requireDevTools();
    return {};
};
