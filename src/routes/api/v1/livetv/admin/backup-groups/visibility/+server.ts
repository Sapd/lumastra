// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PUT /api/v1/livetv/admin/backup-groups/visibility — take stations off air / put them on air
 * Auth scope: livetv:admin
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/livetv/admin/backup-groups/visibility.js';

export const { PUT } = mount(def, { surface: 'v1' });
