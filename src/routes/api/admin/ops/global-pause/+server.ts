// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET    /api/admin/ops/global-pause — pause + quiet-hours status
 * POST   /api/admin/ops/global-pause — pause everything for N hours
 * DELETE /api/admin/ops/global-pause — resume early
 * Mounted from: src/lib/server/api/defs/admin/ops/global-pause.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/ops/global-pause.js';

const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = mount(def, {
    surface: 'internal',
});
export { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD };
