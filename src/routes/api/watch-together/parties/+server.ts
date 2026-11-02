// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together API — List Public Sessions
 *
 *   GET /api/watch-together/parties → paginate({ items: PublicWatchTogetherParty[], page })
 *
 * Definition: $lib/server/api/defs/watch-together/parties.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/watch-together/parties.js';

export const { GET } = mount(def, { surface: 'internal' });

import { mount as mountCreate } from '$lib/server/api/mount.js';
import { def as createDef } from '$lib/server/api/defs/watch-together/parties-create.js';

export const { POST } = mountCreate(createDef, { surface: 'internal' });
