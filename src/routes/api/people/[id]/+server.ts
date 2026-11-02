// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/people/{id}
 *
 * The def is mounted here (internal surface) and on the v1 surface via the
 * shim at src/routes/api/v1/people/[id]/+server.ts.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/people-id.js';

export const { GET } = mount(def, { surface: 'internal' });
