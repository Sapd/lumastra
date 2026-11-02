// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Admin UI Components
export { default as AdminPageHeader } from './AdminPageHeader.svelte';
export { default as CoverageDashboard } from './CoverageDashboard.svelte';
export { default as ActionButton } from './ActionButton.svelte';
export { default as IdentifyModal } from './IdentifyModal.svelte';
export { default as MediaRankCard } from './MediaRankCard.svelte';
export { default as TimeframeSelector } from './TimeframeSelector.svelte';
export { default as ChartCard } from './ChartCard.svelte';
export { default as DevModeSwitcher } from './DevModeSwitcher.svelte';
export { default as SettingInput } from './SettingInput.svelte';
export { default as SettingSection } from './SettingSection.svelte';
export { default as BandwidthChart } from './BandwidthChart.svelte';
export { default as StatCard } from './StatCard.svelte';
export { default as ProgressBar } from './ProgressBar.svelte';
export { default as GpuMetricsSection } from './GpuMetricsSection.svelte';

// Cache management components
export { default as CacheSection } from './CacheSection.svelte';
export { default as NamespaceTable } from './NamespaceTable.svelte';
export { default as FilesystemCacheSection } from './FilesystemCacheSection.svelte';
export { default as StandaloneCacheSection } from './StandaloneCacheSection.svelte';
export { default as SubtitleCacheCard } from './SubtitleCacheCard.svelte';

// Task management components
export { default as ActionModal } from './ActionModal.svelte';

// Session management components
export { default as ActivePlaySessionsPanel } from './ActivePlaySessionsPanel.svelte';
export { default as SendSessionMessageModal } from './SendSessionMessageModal.svelte';
export { default as MaintenanceNoticeCard } from './MaintenanceNoticeCard.svelte';

// Dashboard components
export { default as ServiceHealthGrid } from './ServiceHealthGrid.svelte';

// Library management modals
export { default as LibraryGroupModal } from './LibraryGroupModal.svelte';
export { default as LibraryPathModal } from './LibraryPathModal.svelte';

// Token management components
export { default as TokenTable } from './TokenTable.svelte';
export { default as TokenSuccessModal } from './TokenSuccessModal.svelte';

// User management components
export { default as UserTable } from './UserTable.svelte';
export { default as AdminWorkspaceTabs } from './AdminWorkspaceTabs.svelte';

// Navigation components (admin IA redesign, spec §4 — manifest-driven renderers)
export { default as AdminMegaMenu } from './nav/AdminMegaMenu.svelte';
export { default as AdminSidebar } from './nav/AdminSidebar.svelte';
export { default as AdminNavDrawer } from './nav/AdminNavDrawer.svelte';
export { default as AdminBreadcrumb } from './nav/AdminBreadcrumb.svelte';
export { default as AdminSectionTabs } from './nav/AdminSectionTabs.svelte';

// The two admin help primitives, and the only two: HelpPopover explains a
// screen (the header "?" and the in-flow "What is this page?" disclosure that
// used to be WhatIsThisPage.svelte), TermTooltip explains a word.
export { default as HelpPopover } from './HelpPopover.svelte';
export { default as TermTooltip } from './glossary/TermTooltip.svelte';
export { GLOSSARY } from './glossary/glossary.js';

// Embeddings components
export { default as DataQualityMetric } from './embeddings/DataQualityMetric.svelte';
export { default as EmbeddingSearchWidget } from './embeddings/EmbeddingSearchWidget.svelte';
export { default as EmbeddingLookupWidget } from './embeddings/EmbeddingLookupWidget.svelte';

// Playback quality components
export { default as UsersIssueTable } from './playback/UsersIssueTable.svelte';
export { default as DevicesIssueTable } from './playback/DevicesIssueTable.svelte';

// Settings components
export { default as AdminSettingsPage } from './settings/AdminSettingsPage.svelte';
export { default as StickySaveBar } from './settings/StickySaveBar.svelte';
export { default as SearchInput } from './settings/SearchInput.svelte';

// Stats components
export { default as UserRankCard } from './stats/UserRankCard.svelte';

// Reusable per-task operator dashboard (generalizes the sonic-embeddings pattern)
export { default as TaskDashboard } from './task-dashboard/TaskDashboard.svelte';

// Shared detail-panel shell + primitives (admin IA redesign, spec §6)
export { default as DetailPanel } from './detail/DetailPanel.svelte';
export { default as AsyncSection } from './AsyncSection.svelte';
export { default as InfoRailCard } from './InfoRailCard.svelte';

export { default as JellyfinPairingStatus } from './JellyfinPairingStatus.svelte';
