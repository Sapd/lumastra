// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/radio/stations — access-scoped list of internet radio stations.
// v1 surface: image hrefs point at /api/v1/media/...
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/radio/stations.js';

export const { GET } = mount(def, { surface: 'v1' });
