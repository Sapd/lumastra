// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together API — Report Stall Ready (Buffering Recovered)
 *
 *   POST /api/watch-together/{code}/stall-ready → 204 No Content
 *
 * Definition: $lib/server/api/defs/watch-together/[code]/stall-ready.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/watch-together/[code]/stall-ready.js';

export const { POST } = mount(def, { surface: 'internal' });
