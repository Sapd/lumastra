// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET/POST /api/v1/media/{id}/renditions
 * Mounted from: src/lib/server/api/defs/media/[id]/renditions.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/media/[id]/renditions.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
