// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { requireDevTools } from '$lib/server/admin/require-dev-tools.js';

// Admin auth already happens in src/routes/admin/+layout.server.ts (isAdmin
// check). This page is otherwise entirely client-driven (fetches its own
// stats via $lib/api/admin) — the only server-side job left is the
// Developer-section gate.
export const load: PageServerLoad = async () => {
    requireDevTools();
    return {};
};
