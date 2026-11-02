// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/admin/playback-incidents
 * Mounted from: src/lib/server/api/defs/admin/playback-incidents/index.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/playback-incidents/index.js';

export const { GET, DELETE } = mount(def, { surface: 'v1' });
