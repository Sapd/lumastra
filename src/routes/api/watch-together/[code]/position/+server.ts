// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together API — Report Position (Drift Detection)
 *
 *   POST /api/watch-together/{code}/position → { resyncing: boolean }
 *
 * Definition: $lib/server/api/defs/watch-together/[code]/position.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/watch-together/[code]/position.js';

export const { POST } = mount(def, { surface: 'internal' });
