<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Manual music credit review

Track Overview → Artist credits uses the existing metadata GET/PATCH endpoint with an exclusive `confirmArtistCredits` branch. The review token is a server hash of the track, actual album and owner, existing referenced artist rows and their row versions. The UI never splits a raw name or changes album ownership. Explicit new artists are created only inside the confirmed transaction; normalized title/alias collisions ask the operator to select the existing artist.

Apply takes the scanner/deletion advisory lock and deterministic row locks, rereads the review, updates only credit membership metadata and protection, and writes the authenticated audit record in the same transaction. Failed validation or audit rolls back created artists and credits. `metadata_locked` preserves the manual credits through changed-tag audio ingest. Canonical performer order, remixer roles, unrelated memberships, source tags, title/source, file versions and defaults, provider data and user history are retained. The client rereads canonical credits and compares the ordered result and protection before announcing verified success. Uncertain saves require a fresh review rather than an automatic repeat.

Artist Tracks includes owned album descendants and canonical performer/remixer membership across other albums. The admin API returns a separate paged object for artists (50 rows), with full catalog totals and duration; the legacy album array remains unchanged. Availability filters examine all linked versions. `music_from_artist_tracks` retains a validated artist return identity alongside filter/sort/page context. Entering an actual album makes its return take precedence, while the album can still return to the artist workspace.

# Boundary evidence

`media_file_items.boundary_origin` records the evidence for each inclusive start boundary independently of `offset_source='manual'`, which continues to protect the mapping from scanner changes. Allowed origins are manual, chapter, runtime-split, even-split and unknown. Saving an estimate preserves its origin; legacy manual mappings without recorded evidence remain unknown. Canonical editor responses, remembered content link-set entries, restoration after rename and content revalidation preserve the origin. Resetting manual mappings clears it. No estimate is promoted to verified content evidence.
