// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/requests — create a media request (browser/forward-auth surface)
// GET  /api/requests — list requests
// Mounted from the shared def; surface = 'internal'.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/requests/index.js';

export const { GET, POST } = mount(def, { surface: 'internal' });
