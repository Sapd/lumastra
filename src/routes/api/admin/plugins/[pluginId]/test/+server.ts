// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/plugins/[pluginId]/test
 * Mounted from: src/lib/server/api/defs/admin/plugins/[pluginId]/test.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/plugins/[pluginId]/test.js';

const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = mount(def, {
    surface: 'internal',
});
export { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD };
