// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/POST /api/v1/me/music/pinned-genres — public/native surface.
// DELETE lives at /api/v1/me/music/pinned-genres/{genre} so clients never have to
// send a DELETE body (dropped by some HTTP clients, proxies and SDK generators).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/user/music/pinned-genres.js';

export const { GET, POST } = mount(def, { surface: 'v1' });
