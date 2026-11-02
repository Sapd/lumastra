// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/plugins/external/install
 * Mounted from: src/lib/server/api/defs/plugins/external/install.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/plugins/external/install.js';

export const { POST } = mount(def, { surface: 'v1' });
