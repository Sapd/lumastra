// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/music/radio/{id}/now-playing — live now-playing metadata for a station.
// Internal (dashboard) surface.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/radio/[id]/now-playing.js';

export const { GET } = mount(def, { surface: 'internal' });
