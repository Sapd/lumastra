// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET/POST /api/v1/people/{id}/comments
 */
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/people/[id]/comments/index.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
