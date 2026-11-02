// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/tracks — flat track browse, public/native (Bearer) surface.
// Same def as the internal /api/music/tracks route; OpenAPI docs live in the
// def's `docs` field.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/tracks.js';

export const { GET } = mount(def, { surface: 'v1' });
