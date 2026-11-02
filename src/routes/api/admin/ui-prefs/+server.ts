// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET/PATCH /api/admin/ui-prefs
 * Mounted from: src/lib/server/api/defs/admin/ui-prefs.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/ui-prefs.js';

const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = mount(def, {
    surface: 'internal',
});
export { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD };
