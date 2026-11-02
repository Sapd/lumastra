// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET  /api/v1/livetv/admin/backup-groups — list backup groups + ungrouped channels
 * POST /api/v1/livetv/admin/backup-groups — create backup group
 * Auth scope: livetv:admin
 *
 * Retired: delegateToAdmin shim — now mounted directly via def.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/livetv/admin/backup-groups/index.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
