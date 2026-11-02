// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Section Components Index
 *
 * Export all section components for Server-Driven UI architecture.
 * Use SectionRenderer as the main entry point for rendering sections.
 */

// Main entry point - routes to correct section component
export { default as SectionRenderer } from './SectionRenderer.svelte';

// Layout sections
export { default as StandardSection } from './StandardSection.svelte';
export { default as ListSection } from './ListSection.svelte';

// Specialized sections
export { default as HeroSection } from './HeroSection.svelte';
export { default as HeroControls } from './HeroControls.svelte';
export { default as CalendarSection } from './CalendarSection.svelte';
export { default as LiveSessionSection } from './LiveSessionSection.svelte';
export { default as KeywordChipsSection } from './KeywordChipsSection.svelte';
