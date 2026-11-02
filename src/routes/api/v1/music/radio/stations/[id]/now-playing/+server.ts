// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/radio/stations/{id}/now-playing — live now-playing metadata.
// v1 surface.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/radio/[id]/now-playing.js';

export const { GET } = mount(def, { surface: 'v1' });
