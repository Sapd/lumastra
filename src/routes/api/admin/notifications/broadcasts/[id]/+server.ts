// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PATCH  /api/admin/notifications/broadcasts/{id}
 * DELETE /api/admin/notifications/broadcasts/{id}
 * Mounted from: src/lib/server/api/defs/admin/notifications/broadcasts/[id]/index.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/notifications/broadcasts/[id]/index.js';

const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = mount(def, {
    surface: 'internal',
});
export { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD };
