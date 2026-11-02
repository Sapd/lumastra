// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// SPA surface mount: GET    /api/admin/users/:username/stream-policy
//                    PUT    /api/admin/users/:username/stream-policy
//                    DELETE /api/admin/users/:username/stream-policy
// Auth: scope users:admin (tokens) or admin session (browser dashboard).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/users/[username]/stream-policy.js';

export const { GET, PUT, DELETE } = mount(def, { surface: 'internal' });
