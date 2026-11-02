// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mount } from '$lib/server/api/mount.js';
import { malDirectionDef } from '$lib/server/api/defs/integrations/mal/direction.js';

export const { GET, PUT } = mount(malDirectionDef, {
    surface: 'internal',
});
