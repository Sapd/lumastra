// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// SPA surface mount: GET/POST/DELETE /api/admin/users/:username/subsonic-password
// Auth: scope users:admin (tokens) or admin session (browser dashboard).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/users/[username]/subsonic-password.js';

export const { GET, POST, DELETE } = mount(def, { surface: 'internal' });
