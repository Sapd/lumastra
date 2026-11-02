// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/livetv/categories/[categoryId]/channel-count — channel count for category
 *
 * Auth delegated to the def (scope: livetv:admin).
 * Retired: requireAdmin + ApiResponses.success — now mounted via def.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/livetv/admin/categories/[id]/channel-count.js';

export const { GET } = mount(def, { surface: 'internal' });
