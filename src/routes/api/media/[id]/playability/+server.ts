// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/media/{id}/playability (session surface)
 * Mounted from: src/lib/server/api/defs/media/[id]/playability.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/media/[id]/playability.js';

export const { POST } = mount(def, { surface: 'internal' });
