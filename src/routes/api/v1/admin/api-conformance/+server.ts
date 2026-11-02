// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/admin/api-conformance — the same report as /api/admin/api-conformance on the v1
 * surface, so the release routine's deploy check can read it with an admin service token.
 * Mounted from: src/lib/server/api/defs/admin/api-conformance/index.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/api-conformance/index.js';

export const { GET } = mount(def, { surface: 'v1' });
