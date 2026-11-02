// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Movies/{itemId}/Similar — an alias Jellyfin's LibraryController.GetSimilarItems
// answers exactly like /Items/{itemId}/Similar.
export { GET } from '../../../Items/[itemId]/Similar/+server';
