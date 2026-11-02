// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/me/resume-handoff — where a paused player should catch up to.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/me/resume-handoff.js';

export const { GET } = mount(def, { surface: 'v1' });
