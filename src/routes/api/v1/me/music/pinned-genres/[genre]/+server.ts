// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// DELETE /api/v1/me/music/pinned-genres/{genre} — public/native surface.
// The def reads the genre from event.params.genre here, falling back to a JSON
// body for the internal route.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/user/music/pinned-genres.js';

export const { DELETE } = mount(def, { surface: 'v1' });
