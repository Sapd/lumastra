// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { jellyfinActivityDef } from '$lib/server/api/defs/integrations/jellyfin/activity.js';

export const { GET } = mount(jellyfinActivityDef, { surface: 'internal' });
