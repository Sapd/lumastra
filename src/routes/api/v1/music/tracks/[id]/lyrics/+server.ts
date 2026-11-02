// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET  /api/v1/music/tracks/{id}/lyrics — fetch track lyrics
 * PUT  /api/v1/music/tracks/{id}/lyrics — upload/replace lyrics (admin only)
 *
 * v1 public surface mount.  Contract and handler live in the def.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/tracks/[id]/lyrics.js';

export const { GET, PUT } = mount(def, { surface: 'v1' });
