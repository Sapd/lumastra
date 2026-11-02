// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together API — Join Session
 *
 *   POST /api/watch-together/{code}/join → { party: WatchTogetherParty }
 *
 * Definition: $lib/server/api/defs/watch-together/[code]/join.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/watch-together/[code]/join.js';

export const { POST } = mount(def, { surface: 'internal' });
