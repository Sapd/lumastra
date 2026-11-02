// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /api/admin/livetv/backup-groups/[groupId]/channels — remove channel from group
 * POST   /api/admin/livetv/backup-groups/[groupId]/channels — add channel to group
 *
 * Auth delegated to the def (scope: livetv:admin).
 * Retired: requireAdmin + ApiResponses.success — now mounted via def.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/livetv/admin/backup-groups/[id]/channels.js';

export const { POST, DELETE } = mount(def, { surface: 'internal' });
