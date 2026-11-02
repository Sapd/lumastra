// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/mood-recommendations — public/native surface.
// Internal path is /api/music/sections/mood-recommendations; the v1 path drops
// the BFF "sections/" prefix because the response is a plain track list.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/sections/mood-recommendations.js';

export const { GET } = mount(def, { surface: 'v1' });
