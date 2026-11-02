// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/v1/requests/status — batch request-status check (token surface).
//
// This is the only surface that carries live download progress (`download.percentage`,
// `statusMessage`). The v1 mount was dropped in 6dee55dc5 along with the legacy
// `/api/v1/request/status` path, which left token clients (tvOS) with no way to read
// progress at all — `/api/requests/status` sits behind forward auth (it is not in
// isBypassAuthPath()), so a Bearer credential cannot reach it.
//
// Response: bare JSON array of RequestStatusResult objects — same shape as the
// internal surface. Delegates to the shared def; surface = 'v1'.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/requests/status.js';

export const { POST } = mount(def, { surface: 'v1' });
