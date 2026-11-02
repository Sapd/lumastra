// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/request/redirect — resolve a provider-agnostic media ID to a Jellyseerr
// deep-link and issue a 302 redirect (internal BFF surface, Class R).
// Delegates to the shared def; surface = 'internal'.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/requests/redirect.js';

export const { GET } = mount(def, { surface: 'internal' });
