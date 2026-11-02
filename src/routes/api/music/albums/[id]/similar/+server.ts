// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/music/albums/{id}/similar — acoustically similar albums.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/albums/[id]/similar.js';

export const { GET } = mount(def, { surface: 'internal' });
