// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { malActivityDef } from '$lib/server/api/defs/integrations/mal/activity.js';

export const { GET } = mount(malActivityDef, { surface: 'internal' });
