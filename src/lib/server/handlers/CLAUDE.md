# handlers/

HLS streaming request handlers — segment serving, trickplay images, and subtitle injection.

## Files

| File                       | What                                              | When to read                                    |
| -------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `hls/iframe-handler.ts`    | Serves HLS I-frame (trickplay thumbnail) segments | Debugging trickplay, implementing seek previews |
| `hls/subtitle-handler.ts`  | Injects subtitle tracks into HLS manifests        | Implementing subtitle support in HLS streams    |
| `hls/trickplay-handler.ts` | Orchestrates trickplay tile loading and caching   | Implementing trickplay thumbnail features       |

## HLS segment grid

- **Count and size segments through `uniformSegmentCount` / `uniformSegmentDuration`**
  (`utils/hls-segment-grid.ts`), never `Math.ceil(total / segmentSeconds)`. A container a few
  milliseconds longer than its last video frame would list a phantom final entry that FFmpeg never
  writes for video, and the miss serves the previous segment's bytes. The helpers fold a remainder
  shorter than `HLS_TAIL_MERGE_SECONDS` (or a quarter segment) into the last entry.
- **Read the end-segment cache through `lookupEndSegment` / `storeEndSegment`**
  (`services/hls/end-segment-cache.ts`), not `.get` plus serve. An entry answers only its own segment
  index, or only the last grid entry for a tail run.
- **A closed manifest alone does not prove the stream ended.** A stopped FFmpeg also writes the
  end marker, so treat the last entry as missing only when the job reached the end of its input.
