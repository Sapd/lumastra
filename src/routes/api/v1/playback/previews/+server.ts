// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/playback/previews
 *
 * Create an ephemeral hover-preview transcode session.
 * Auth: authenticated user (Bearer, PAT, session).
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/playback/previews/index.js';

export const { POST } = mount(def, { surface: 'v1' });
