// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/plugins/external
 * Mounted from: src/lib/server/api/defs/plugins/external/index.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/plugins/external/index.js';

export const { GET } = mount(def, { surface: 'v1' });
