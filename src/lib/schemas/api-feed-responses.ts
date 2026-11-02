// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Feed API response schemas — SINGLE SOURCE OF TRUTH for the OpenAPI contract
 * of the SDUI feed composition endpoints:
 *
 *   GET /api/v1/feed   (surface: v1)
 *   GET /api/feed      (surface: internal)
 *
 * Both routes mount the SAME def (`defs/recommendations/feed.ts`), so one
 * schema covers both surfaces.
 *
 * WHAT /feed ACTUALLY EMITS
 * -------------------------
 * The handler's SECTION_PLAN produces a flat list of SDUI sections, each one a
 * single shape today: `{ type: 'carousel', id, title, items, source: { href } }`.
 * Every section's `items` are the canonical NESTED recommendation envelope
 * `{ media, score?, reason? }` — the SAME `RecommendationItem` component that the
 * Tier-2 rails (/recommendations, /trending, …) emit. The feed reuses that
 * canonical thin item (nested `media.images{}` href map) rather than a flat
 * `posterUrl` field; the recommender rails have never used `posterUrl`.
 *
 * WHY A DISCRIMINATED UNION
 * -------------------------
 * The section wrapper is modeled as a `z.discriminatedUnion('type', [...])` even
 * though the handler emits exactly one variant today. This documents the section
 * `type` as a closed, switchable discriminator for clients and gives a clean
 * extension point: future non-carousel kinds (hero, keyword-chips, …) become
 * sibling variants discriminated on the same `type` literal. Media-bearing
 * variants ALWAYS reference the canonical `RecommendationItem` — never re-inline
 * the media object.
 *
 * CONTRACT STABILITY
 * ------------------
 * The section *shapes* (each discriminated-union variant + the item envelope)
 * ARE stable and safe to pin to. The section *list* — which sections appear,
 * their order, and their presence — is SERVER-OWNED and deliberately NOT
 * stable: it varies per user and per request. Clients MUST ignore section
 * `type` values they don't recognise and MUST ignore unknown fields, so the
 * server can add / remove / reorder sections without any client release.
 * Section `id`s are opaque strings; a client MAY special-case a known id
 * (e.g. `watching`, `byw:<uuid>`) but MUST NOT require one to be present.
 */

import { z } from 'zod';
import { AudiobookPreviewSchema } from './api-audiobook-preview.js';
import { publicAuthorSchema } from './public-author';
import {
    RecommendationItemSchema,
    ContinueWatchingRecommendationItemSchema,
} from './api-recommender-responses';

/**
 * A single SDUI carousel section — the only variant the handler emits today.
 * `items` are the canonical nested recommendation envelope `{ media, score?,
 * reason? }`; `source.href` links to the Tier-2 endpoint that backs the section
 * so power clients can "see all".
 */
export const MediaCarouselSectionSchema = z
    .object({
        type: z.literal('carousel').describe('Section presentation type'),
        id: z.string().describe('Stable section identifier (same as the backing strategy id)'),
        title: z.string().describe('Human-readable section title'),
        icon: z
            .string()
            .optional()
            .describe('Heroicon name for the section header (e.g. `sparkles`, `fire`, `star`)'),
        items: z
            .array(RecommendationItemSchema)
            .describe('Preview items — canonical nested { media, score?, reason? } envelope'),
        source: z
            .object({ href: z.string() })
            .describe('Link to the full Tier-2 data-plane endpoint backing this section'),
    })
    .meta({
        id: 'MediaCarouselSection',
        description:
            'An SDUI carousel section. `items` are the canonical RecommendationItem envelope; ' +
            '`source.href` points at the Tier-2 endpoint that backs the section.',
    });

export type MediaCarouselSection = z.infer<typeof MediaCarouselSectionSchema>;

/**
 * A watching item = the continue-watching envelope + the render-state fields the
 * web Continue-Watching card (`UniversalMediaCard`) uses, so a native client can
 * replicate the web row EXACTLY: `origin` (which query produced it),
 * `livePlaybackState` ('playing' → "Playing now" treatment vs 'paused' →
 * "Paused 3m ago"), and `isSuspicious` (bulk-mark amber warning affordance).
 */
export const WatchingFeedItemSchema = ContinueWatchingRecommendationItemSchema.extend({
    origin: z
        .enum(['cw', 'nextup'])
        .describe(
            "'cw' = in-progress resume; 'nextup' = next unwatched episode in a watched series",
        ),
    livePlaybackState: z
        .enum(['playing', 'paused'])
        .optional()
        .describe("Live-session overlay state: 'playing' = a fresh active session backs this row."),
    isSuspicious: z
        .boolean()
        .optional()
        .describe(
            'Watch state recorded inside a bulk-mark sync window — render the confirm/hide warning.',
        ),
}).meta({ id: 'WatchingFeedItem' });

export type WatchingFeedItem = z.infer<typeof WatchingFeedItemSchema>;

/**
 * The merged Continue-Watching + Next-Up section, recency-interleaved. One
 * card per series (server-arbitrated). Distinct from a plain carousel because
 * its items carry watch-state (progress/resume/lastPlayedAt) and an `origin`.
 */
export const WatchingSectionSchema = z
    .object({
        type: z.literal('watching'),
        id: z.string().describe("Opaque section id (always 'watching' today)"),
        title: z.string(),
        items: z.array(WatchingFeedItemSchema),
        source: z.object({ href: z.string() }),
    })
    .meta({ id: 'WatchingSection' });

export type WatchingSection = z.infer<typeof WatchingSectionSchema>;

export const AudiobookActivityItemSchema = z
    .object({
        author: publicAuthorSchema,
        media: AudiobookPreviewSchema,
        kind: z.enum(['listened', 'finished']),
        listenedMinutes: z.number().int().positive().optional(),
        occurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        approximate: z.boolean(),
    })
    .meta({ id: 'AudiobookActivityItem' });

export type AudiobookActivityItem = z.infer<typeof AudiobookActivityItemSchema>;

export const AudiobookActivitySectionSchema = z
    .object({
        type: z.literal('audiobook-activity'),
        id: z.literal('audiobook-activity'),
        title: z.string(),
        items: z.array(AudiobookActivityItemSchema),
    })
    .meta({
        id: 'AudiobookActivitySection',
        description:
            'A seven-day, person-per-book audiobook activity rail. Durations and dates are intentionally coarse.',
    });

export type AudiobookActivitySection = z.infer<typeof AudiobookActivitySectionSchema>;

/** Narrow internal /feed request used by the optional dashboard activity rail. */
export const AudiobookActivityFeedResponseSchema = z.object({
    sections: z.array(
        AudiobookActivitySectionSchema.extend({
            source: z.object({ href: z.string() }),
        }),
    ),
});

/**
 * One SDUI feed section, discriminated on the `type` literal.
 *
 * `carousel` and `watching` exist today. When the feed grows further
 * non-carousel kinds, add sibling variants here (e.g. a single-item `hero`, a
 * `keyword-chips` payload), each discriminated on the same `type` literal.
 * Media-bearing variants must reference `RecommendationItemSchema` (or
 * `WatchingFeedItemSchema`) rather than re-inlining the media shape.
 */
export const FeedSectionSchema = z
    .discriminatedUnion('type', [
        MediaCarouselSectionSchema,
        WatchingSectionSchema,
        AudiobookActivitySectionSchema,
    ])
    .meta({
        id: 'FeedSection',
        description:
            'An SDUI feed section, discriminated on `type` (`carousel`, `watching`, or `audiobook-activity`). ' +
            'Additional kinds will be added as sibling variants on the same discriminator.',
    });

export type FeedSection = z.infer<typeof FeedSectionSchema>;

/**
 * `GET /feed` response envelope — `{ sections: FeedSection[] }`.
 *
 * A section is omitted entirely when its strategy returns 0 items or its
 * dependency is down (fault isolation — the aggregate response stays 200).
 */
export const FeedResponseSchema = z
    .object({
        sections: z.array(FeedSectionSchema).describe('Composited SDUI feed sections'),
        pendingSections: z
            .array(z.string())
            .optional()
            .describe(
                'Section ids left out of THIS response because they exceeded their time ' +
                    'budget; they are still being computed server-side. Present only when ' +
                    'non-empty — a client may re-fetch once after a few seconds to pick them up.',
            ),
    })
    .meta({
        id: 'FeedResponse',
        description:
            'SDUI feed sections for the authenticated user. Section SHAPES are a ' +
            'stable contract; the section LIST/order is server-owned and varies per ' +
            'request — clients must ignore unknown section types and fields.',
    });

export type FeedResponse = z.infer<typeof FeedResponseSchema>;
