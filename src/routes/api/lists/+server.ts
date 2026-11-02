// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/lists  — user-authed list of curated lists (SPA surface)
// POST /api/lists — admin-only sync trigger
// Auto-generated mount — do not add handler logic here.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/lists/index.js';

export const { GET, POST } = mount(def, { surface: 'internal' });
