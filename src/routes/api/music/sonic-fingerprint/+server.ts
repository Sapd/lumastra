// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/music/sonic-fingerprint
// User's sonic fingerprint as a PageSection | null (LazySection-compatible).
// Fingerprint = recency-weighted centroid of user's most-played tracks' MSCLAP embeddings → kNN.
// Gating: features.sonicEmbeddings. Auth: any authenticated user.
// Response: bare PageSection | null. null = no play history or no embeddings yet.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/sonic-fingerprint.js';

export const { GET } = mount(def, { surface: 'internal' });
