// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/livetv/playback-sessions/[playbackSessionId]/leave.js';
export const { POST } = mount(def, { surface: 'internal' });
