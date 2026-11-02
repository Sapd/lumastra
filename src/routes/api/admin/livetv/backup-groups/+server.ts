// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET  /api/admin/livetv/backup-groups — list backup groups + ungrouped channels
 * POST /api/admin/livetv/backup-groups — create backup group
 *
 * Auth delegated to the def (scope: livetv:admin).
 * Retired: requireAdmin + ApiResponses.success — now mounted via def.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/livetv/admin/backup-groups/index.js';

export const { GET, POST } = mount(def, { surface: 'internal' });
