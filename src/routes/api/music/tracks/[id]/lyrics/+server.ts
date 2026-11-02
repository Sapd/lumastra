// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET  /api/music/tracks/{id}/lyrics — fetch track lyrics
 * PUT  /api/music/tracks/{id}/lyrics — upload/replace lyrics (admin only)
 *
 * Internal BFF surface mount.  Contract lives in the def; this file is thin.
 * Response shape: bare object { lyrics, syncedLines? } + problem+json errors.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/tracks/[id]/lyrics.js';

export const { GET, PUT } = mount(def, { surface: 'internal' });
