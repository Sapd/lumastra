// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// withJellyfinAuth also checks the legacy path userId. DatePlayed is optional;
// as on the current route, watch-event time is assigned by the server.
export { POST, DELETE } from '../../../../UserPlayedItems/[itemId]/+server';
