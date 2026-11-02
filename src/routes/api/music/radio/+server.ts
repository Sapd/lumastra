// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/music/radio — access-scoped list of internet radio stations.
// Internal (dashboard) surface: image hrefs point at /api/image/...
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/radio/stations.js';

export const { GET } = mount(def, { surface: 'internal' });
