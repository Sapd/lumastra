// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/music/debug/crossfade?from=<trackId>&to=<trackId>[&mood=chill]
 *
 * Admin-only debug endpoint — internal BFF surface mount.
 * Contract lives in the def; this file is thin.
 * Response: bare object with crossfade analysis + problem+json errors.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/debug/crossfade.js';

export const { GET } = mount(def, { surface: 'internal' });
