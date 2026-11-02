// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/admin/transcode-failures/session/[playSessionId]
 * Mounted from: src/lib/server/api/defs/admin/transcode-failures/session.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/transcode-failures/session.js';

export const { GET } = mount(def, { surface: 'v1' });
