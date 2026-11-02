// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/routes/api/play-sessions/[id]/transcode-progress/+server.ts
// Live transcode progress for the web player's info badge (internal/cookie surface).
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/play-sessions/[id]/transcode-progress.js';

export const { GET } = mount(def, { surface: 'internal' });
