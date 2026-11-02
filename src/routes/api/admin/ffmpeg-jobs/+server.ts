// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/ffmpeg-jobs
 * GET    → { jobs, count, config }; errors → problem+json.
 * DELETE → { stopped, playSessionId }; errors → problem+json.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/ffmpeg-jobs/index.js';

export const { GET, DELETE } = mount(def, { surface: 'internal' });
