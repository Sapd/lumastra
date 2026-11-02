// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/admin/playback-incidents/{id}
 * Mounted from: src/lib/server/api/defs/admin/playback-incidents/[id]/index.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/playback-incidents/[id]/index.js';

export const { GET, DELETE } = mount(def, { surface: 'v1' });
