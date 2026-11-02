// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /api/v1/livetv/admin/backup-groups/{groupId}/channels — remove channel from group
 * POST   /api/v1/livetv/admin/backup-groups/{groupId}/channels — add channel to group
 * Auth scope: livetv:admin
 *
 * Retired: delegateToAdmin shim — now mounted directly via def.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/livetv/admin/backup-groups/[id]/channels.js';

export const { POST, DELETE } = mount(def, { surface: 'v1' });
