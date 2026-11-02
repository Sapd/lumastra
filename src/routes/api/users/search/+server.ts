// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/users/search?q=<query> — SPA-internal surface mount.
 * GET → { items: [{id,username}][], page }
 * Errors: problem+json.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/users/search.js';

export const { GET } = mount(def, { surface: 'internal' });
