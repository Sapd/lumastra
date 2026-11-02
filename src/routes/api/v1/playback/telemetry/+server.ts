// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/playback/telemetry
 *
 * Public API telemetry endpoint for external players (tvOS, native HLS, etc.).
 * Rate-limited to 30 req/min per user; each request may carry up to 100 events.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/playback/telemetry.js';

export const { POST } = mount(def, { surface: 'v1' });
