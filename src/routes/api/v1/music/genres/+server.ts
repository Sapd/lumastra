// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/genres — public/native (Bearer token) surface. Mounts the
// SAME shared def as the internal /api/music/genres route. OpenAPI docs live in
// the def's `docs` field (the retired _openapi.ts).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/genres.js';

export const { GET } = mount(def, { surface: 'v1' });
