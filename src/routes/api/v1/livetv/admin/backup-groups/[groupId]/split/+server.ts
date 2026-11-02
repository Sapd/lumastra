// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/livetv/admin/backup-groups/{groupId}/split — split backup group
 * Auth scope: livetv:admin
 *
 * Retired: delegateToAdmin shim — now mounted directly via def.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/livetv/admin/backup-groups/[id]/split.js';

export const { POST } = mount(def, { surface: 'v1' });
