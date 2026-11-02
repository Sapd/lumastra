// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Modal Components
 *
 * Sub-components for ModalMovie that handle specific sections:
 * - ModalHeader: Title, series name, overview
 * - ModalActions: Play, watchlist, rating, watched buttons
 * - ModalBody: Metadata, ratings, cast, social activity
 * - ModalSeasons: Seasons and episodes picker for series
 * - ActorChip: Interactive actor chip with hover image preview
 * - ActorModal: Actor details and filmography modal
 */

export { default as ModalHeader } from './ModalHeader.svelte';
export { default as ModalActions } from './ModalActions.svelte';
export { default as ModalBody } from './ModalBody.svelte';
export { default as ModalAudiobookDetails } from './ModalAudiobookDetails.svelte';
export { default as ModalAudiobookSeries } from './ModalAudiobookSeries.svelte';
export { default as ModalSeasons } from './ModalSeasons.svelte';
export { default as SetSeriesProgressModal } from './SetSeriesProgressModal.svelte';
export { default as ActorChip } from './ActorChip.svelte';
export { default as ActorModal } from './ActorModal.svelte';
export { default as SocialReviewSection } from './SocialReviewSection.svelte';
export { default as AlbumModal } from './AlbumModal.svelte';
export { default as ArtistModal } from './ArtistModal.svelte';
