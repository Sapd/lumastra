// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// SPA surface mount: POST /api/admin/users/:username/password
// Auth: scope users:admin (tokens) or admin session (browser dashboard).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/users/[username]/password.js';

export const { POST } = mount(def, { surface: 'internal' });
