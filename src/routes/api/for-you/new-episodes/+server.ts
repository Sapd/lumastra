// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/for-you/new-episodes — "New episodes available" for the web banner
// (SPA surface). Same def as /api/v1/for-you/new-episodes; surface:'internal'
// uses the session-based principal from hooks.server.ts.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/for-you/new-episodes.js';

export const { GET } = mount(def, { surface: 'internal' });
