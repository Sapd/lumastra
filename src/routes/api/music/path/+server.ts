// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/music/path?from=<uuid>&to=<uuid>&steps=<n>
// Sonic bridge of N tracks interpolated between two seeds in MSCLAP-2023 embedding space.
// Gating: features.sonicEmbeddings. Auth: any authenticated user.
// Response: bare { fromId, toId, stepCount, steps[] } with canonical images{} hrefs per track.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/sonic-path.js';

export const { GET } = mount(def, { surface: 'internal' });
