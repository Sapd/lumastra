// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/music/sonic-mixes — public/native surface for the sonic-cluster def.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/music/sonic-mixes.js';

export const { GET } = mount(def, { surface: 'v1' });
