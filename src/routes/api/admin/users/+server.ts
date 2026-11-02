// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// SPA surface mount: GET /api/admin/users  POST /api/admin/users
// Auth: scope users:admin (tokens) or admin session (browser dashboard).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/users/index.js';

export const { GET, POST } = mount(def, { surface: 'internal' });
