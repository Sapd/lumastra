// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/music/tracks/{id}/similar — kNN-similar tracks
 *
 * v1 public surface mount.  Contract and handler live in the def.
 * Response: { items, page } of MusicTrack with images{} hrefs.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/tracks/[id]/similar.js';

export const { GET } = mount(def, { surface: 'v1' });
