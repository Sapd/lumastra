// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET/PUT /api/v1/integrations/keys/{id}
 * Mounted from: src/lib/server/api/defs/integrations/keys/[id].ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/integrations/keys/[id].js';

export const { GET, PUT } = mount(def, { surface: 'v1' });
