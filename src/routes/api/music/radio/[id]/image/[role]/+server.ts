// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/music/radio/{id}/image/{role} — live metadata image proxy (dj/show/up-next).
// Internal (dashboard) surface. Raw binary response; pre-stream errors are problem+json.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/radio/[id]/images/[role].js';

export const { GET } = mount(def, { surface: 'internal' });
