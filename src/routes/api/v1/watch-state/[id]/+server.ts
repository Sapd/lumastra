// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET/PATCH /api/v1/watch-state/{id}
 * Mounted from: src/lib/server/api/defs/watch-state/[id].ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/watch-state/[id].js';

export const { GET, PATCH } = mount(def, { surface: 'v1' });
