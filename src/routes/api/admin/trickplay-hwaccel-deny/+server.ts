// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET    /api/admin/trickplay-hwaccel-deny
 * DELETE /api/admin/trickplay-hwaccel-deny?codec=…&pixFmt=…
 * Mounted from: src/lib/server/api/defs/admin/trickplay-hwaccel-deny/index.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/trickplay-hwaccel-deny/index.js';

export const { GET, DELETE } = mount(def, { surface: 'internal' });
