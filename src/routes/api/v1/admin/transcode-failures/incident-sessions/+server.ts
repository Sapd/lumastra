// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/admin/transcode-failures/incident-sessions
 * Mounted from: src/lib/server/api/defs/admin/transcode-failures/incident-sessions.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/transcode-failures/incident-sessions.js';

export const { GET } = mount(def, { surface: 'v1' });
