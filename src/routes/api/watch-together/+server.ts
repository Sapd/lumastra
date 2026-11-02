// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together API — Create / Get Active Session
 *
 *   GET  /api/watch-together → { party: WatchTogetherParty | null }
 *
 * Definition: $lib/server/api/defs/watch-together/index.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/watch-together/index.js';

export const { GET } = mount(def, { surface: 'internal' });
