// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/me/manual-runs
 * Mounted from: src/lib/server/api/defs/me/manual-runs.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/me/manual-runs.js';

export const { GET } = mount(def, { surface: 'internal' });
