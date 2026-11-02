// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/ops/work-profile — current work profile + what each preset means
 * PUT /api/admin/ops/work-profile — apply a preset (Gentle/Balanced/Fast)
 * Mounted from: src/lib/server/api/defs/admin/ops/work-profile.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/ops/work-profile.js';

const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = mount(def, {
    surface: 'internal',
});
export { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD };
