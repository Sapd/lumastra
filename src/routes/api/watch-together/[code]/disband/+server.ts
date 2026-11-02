// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together API — Disband Session
 *
 *   POST /api/watch-together/{code}/disband → 204 No Content
 *
 * Definition: $lib/server/api/defs/watch-together/[code]/disband.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/watch-together/[code]/disband.js';

export const { POST } = mount(def, { surface: 'internal' });
