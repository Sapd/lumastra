// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * UI Components Index
 * Export all reusable UI components from a single location
 */

// Core UI primitives
export { default as Button } from './Button.svelte';
export { default as Badge } from './Badge.svelte';
export { default as Toggle } from './Toggle.svelte';
export { default as Card } from './Card.svelte';
export { default as Avatar } from './Avatar.svelte';
export { default as Tooltip } from './Tooltip.svelte';

// Form elements
export { default as Select } from './Select.svelte';
export { default as SearchInput } from './SearchInput.svelte';
export { default as FormField } from './FormField.svelte';

// Navigation
export { default as Pagination } from './Pagination.svelte';
export { default as Tabs } from './Tabs.svelte';

// Feedback & alerts
export { default as Alert } from './Alert.svelte';
export { default as ProgressBar } from './ProgressBar.svelte';
export { default as NavigationProgressBar } from './NavigationProgressBar.svelte';

// Data display
export { default as DataTable } from './DataTable.svelte';
export { default as StatCard } from './StatCard.svelte';
export { default as ChipList } from './ChipList.svelte';
export { default as ChipScrollRow } from './ChipScrollRow.svelte';
export { default as SectionHeader } from './SectionHeader.svelte';

// Feedback & states
export { default as LoadingState } from './LoadingState.svelte';
export { default as Skeleton } from './Skeleton.svelte';
export { default as ProgressRadial } from './ProgressRadial.svelte';
/** @deprecated Use LoadingState instead */
export { default as LoadingSpinner } from './LoadingSpinner.svelte';
export { default as ErrorMessage } from './ErrorMessage.svelte';
export { default as EmptyState } from './EmptyState.svelte';

// Layout & containers
export { default as CollapsibleSection } from './CollapsibleSection.svelte';
export { default as AccordionGroup } from './AccordionGroup.svelte';
export { default as ModalContainer } from './ModalContainer.svelte';
export { default as ConfirmModal } from './ConfirmModal.svelte';
export { default as ShortcutHelpModal } from './ShortcutHelpModal.svelte';

// Media components
export { default as MediaActionButtons } from './MediaActionButtons.svelte';
export { default as MediaCarousel } from './MediaCarousel.svelte';
export { default as UniversalMediaCard } from './UniversalMediaCard.svelte';
export { default as MediaHoverCard } from './MediaHoverCard.svelte';
export { default as WatchlistButton } from './WatchlistButton.svelte';
export { default as WatchButton } from './WatchButton.svelte';
export { default as SendToTVButton } from './SendToTVButton.svelte';

// Dropdowns & menus
export { default as IconDropdown } from './IconDropdown.svelte';

// Ratings
export { default as StarRating } from './StarRating.svelte';
