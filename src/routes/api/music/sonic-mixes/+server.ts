// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/music/sonic-mixes → bare { items: MusicCluster[] }
// The members of one cluster: GET /api/music/sonic-mixes/{id}/tracks.
// Sonic cluster playlists scoped by library-group and age-rating context.
// Gating: features.musicClusters. Auth: any authenticated user.
// Response: canonical images{} hrefs on each cluster.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/sonic-mixes.js';

export const { GET } = mount(def, { surface: 'internal' });
