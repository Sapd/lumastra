// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/request/status — batch status-check for media requests (internal BFF surface).
// Response: bare JSON array of RequestStatusResult objects — same shape as the v1 surface.
// Delegates to the shared def; surface = 'internal'.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/requests/status.js';

export const { POST } = mount(def, { surface: 'internal' });
