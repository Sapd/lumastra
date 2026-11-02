// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/people/{id}
 *
 * v1 token-surface mount for the canonical people detail node.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/catalog/people-id.js';

export const { GET } = mount(def, { surface: 'v1' });
