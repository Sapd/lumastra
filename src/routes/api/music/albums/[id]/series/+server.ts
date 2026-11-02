// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/music/albums/[id]/series
// The title-detected series the album belongs to ("Future Trance Vol. 61 … 70").
// Auth: any authenticated user. Response: bare { albums[], sourceAlbumId }.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/albums/series.js';

export const { GET } = mount(def, { surface: 'internal' });
