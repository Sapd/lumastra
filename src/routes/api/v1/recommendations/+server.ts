// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/recommendations — recommendations multiplexer
// Modes: ai/suggestions, mood, anime, binge-worthy, fresh-releases, short-movies, popular-shows, fulfilled-requests.
// Auto-generated mount — do not add handler logic here.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/recommendations/recommendations.js';

export const { GET } = mount(def, { surface: 'v1' });
