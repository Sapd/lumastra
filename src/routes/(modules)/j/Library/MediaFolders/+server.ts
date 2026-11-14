// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Jellyfin compat: /Library/MediaFolders
//
// Real Jellyfin returns library collection folders here. Seerr's setup wizard
// hits this first before falling back to /Users/{userId}/Views — both return
// the same shape, so we just re-export UserViews's handler to silence the 404
// and keep request logs clean.

export { GET } from '../../UserViews/+server';
