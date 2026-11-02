// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/POST/DELETE /api/me/music/pinned-genres — user pinned genre management
// (internal surface only; dashboard-only, not published to v1).
// Errors are problem+json incl. 503 DB-down, 404 not-found, 422 cap exceeded.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/user/music/pinned-genres.js';

export const { GET, POST, DELETE } = mount(def, {
    surface: 'internal',
});
