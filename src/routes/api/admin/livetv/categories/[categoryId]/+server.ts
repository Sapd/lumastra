// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET    /api/admin/livetv/categories/[categoryId] — get category
 * PUT    /api/admin/livetv/categories/[categoryId] — update visibility/name
 * DELETE /api/admin/livetv/categories/[categoryId] — delete empty category
 *
 * Auth delegated to the def (scope: livetv:admin).
 * Retired: requireAdmin + ApiResponses.success — now mounted via def.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/livetv/admin/categories/[id]/index.js';

export const { GET, PUT, DELETE } = mount(def, { surface: 'internal' });
