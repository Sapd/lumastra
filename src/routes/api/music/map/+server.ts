// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/music/map
// 2D UMAP projection of accessible tracks' MSCLAP embeddings for the starfield UI.
// Gating: features.musicMap. Auth: any authenticated user.
// Response: bare { points[], hasCoords, embeddedCount, totalTracks, projectedCount }.
// Coverage counts are always fresh; point list is cached per access-context.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/map.js';

export const { GET } = mount(def, { surface: 'internal' });
