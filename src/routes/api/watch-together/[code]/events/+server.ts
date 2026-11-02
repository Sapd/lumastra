// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together Events Channel — internal surface
 *
 * POST /api/watch-together/{code}/events   dispatch {clientId,type,payload}
 * GET  /api/watch-together/{code}/events   SSE stream (replaces /stream)
 *
 * Definition: $lib/server/api/defs/watch-together/[code]/events.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/watch-together/[code]/events.js';

export const { GET, POST } = mount(def, { surface: 'internal' });
