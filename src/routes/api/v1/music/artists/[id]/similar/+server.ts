// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/artists/{id}/similar — acoustically similar artists.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/artists/[id]/similar.js';

export const { GET } = mount(def, { surface: 'v1' });
