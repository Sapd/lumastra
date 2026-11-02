// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/moods — the mood vocabulary accepted by mood-recommendations.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/moods.js';

export const { GET } = mount(def, { surface: 'v1' });
