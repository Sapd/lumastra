// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/music/tracks/{id}/similar — kNN-similar tracks
 *
 * Internal BFF surface mount.  Contract lives in the def; this file is thin.
 * Response: { items, page } + problem+json errors incl. 503 on DB-down.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/tracks/[id]/similar.js';

export const { GET } = mount(def, { surface: 'internal' });
