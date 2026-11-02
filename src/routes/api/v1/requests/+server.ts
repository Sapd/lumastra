// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/requests — create a media request (token surface)
// GET  /api/v1/requests — list requests
// Mounted from the shared def; surface = 'v1'.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/requests/index.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
