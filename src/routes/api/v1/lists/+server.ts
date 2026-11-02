// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/lists  — user-authed list of curated lists ({items,page,syncing})
// POST /api/v1/lists — admin-only sync trigger (202 {accepted:true})

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/lists/index.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
