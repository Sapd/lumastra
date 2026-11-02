// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together API — Session Operations
 *
 *   GET    /api/watch-together/{code} → { party: WatchTogetherParty }
 *   DELETE /api/watch-together/{code} → 204 No Content
 *
 * Definition: $lib/server/api/defs/watch-together/[code]/index.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/watch-together/[code]/index.js';

export const { GET, DELETE } = mount(def, { surface: 'internal' });
