# utils/

Server-side utility functions — API responses, media handling, HLS, image processing.

## Files

| File                                            | What                                           | When to read                                                |
| ----------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| `api-responses.ts`                              | Standardized API error/success responses       | Building API routes                                         |
| `api-transforms.ts`                             | API data transformation utilities              | Transforming API data                                       |
| `async-semaphore.ts`                            | Async concurrency limiter                      | Limiting concurrent operations                              |
| `availability-filter.ts`                        | Media availability filtering                   | Filtering by availability                                   |
| `browse-transforms.ts`                          | Browse page data transforms                    | Building browse pages                                       |
| `embedding-utils.ts`                            | Embedding vector utilities                     | Working with embeddings                                     |
| `embedding-utils.test.ts`                       | Embedding utility tests                        | Testing embedding logic                                     |
| `excluded-series.ts`                            | Excluded series utility                        | Managing excluded series                                    |
| `fetch-utils.ts`                                | Server-side HTTP fetch helpers                 | Making HTTP requests                                        |
| `ffmpeg-spawn.ts`                               | FFmpeg process spawning                        | Running FFmpeg                                              |
| `ffmpeg-spawn.integration.test.ts`              | FFmpeg spawn integration tests                 | Testing FFmpeg spawning                                     |
| `ffmpeg-subtitle-extractor.ts`                  | FFmpeg subtitle extraction                     | Extracting subtitles                                        |
| `ffmpeg-subtitle-extractor.integration.test.ts` | FFmpeg subtitle extractor integration tests    | Testing subtitle extraction                                 |
| `ffprobe.ts`                                    | FFprobe media analysis                         | Analyzing media files                                       |
| `ffprobe.test.ts`                               | FFprobe tests                                  | Testing FFprobe logic                                       |
| `hls-audio-injection.ts`                        | HLS audio track injection                      | Adding audio tracks to HLS                                  |
| `hls-definitions.ts`                            | HLS protocol type definitions                  | Using HLS types                                             |
| `hls-master-playlist.ts`                        | HLS master playlist generation                 | Generating master playlists                                 |
| `hls-master-playlist.test.ts`                   | HLS master playlist tests                      | Testing playlist generation                                 |
| `hls-request-utils.ts`                          | HLS request parsing utilities                  | Parsing HLS requests                                        |
| `hls-segment-utils.ts`                          | HLS segment manipulation                       | Manipulating HLS segments                                   |
| `hls-segment-utils.test.ts`                     | HLS segment utility tests                      | Testing segment logic                                       |
| `image-cache-cleanup.ts`                        | Image cache file cleanup                       | Cleaning cached images                                      |
| `image-format.ts`                               | Image format detection                         | Detecting image types                                       |
| `image-params.ts`                               | Image parameter parsing                        | Parsing image parameters                                    |
| `image-proxy.ts`                                | Image proxy utilities                          | Proxying images                                             |
| `keyword-stems.ts`                              | Keyword stemming for search                    | Building search features                                    |
| `logger.ts`                                     | Hand-rolled console logger (not Winston)       | Using logger                                                |
| `media-key-parser.ts`                           | Media composite key parser                     | Parsing media keys                                          |
| `media-key-parser.test.ts`                      | Media key parser tests                         | Testing key parsing                                         |
| `media-path-resolver.ts`                        | Media file path resolution                     | Resolving media paths                                       |
| `media-path-resolver.test.ts`                   | Media path resolver tests                      | Testing path resolution                                     |
| `media-types.ts`                                | Server-side media type comparison functions    | Comparing media types                                       |
| `mkv-subtitle-reader.ts`                        | Minimal Matroska reader for one subtitle track | Reading VobSub packets + palette out of the extractor's MKV |
| `mkv-subtitle-reader.test.ts`                   | Matroska reader tests                          | Testing EBML parsing                                        |
| `pgs-parser.ts`                                 | PGS (Blu-ray) bitmap subtitle decoder          | Decoding `.sup` to timed RGBA cues                          |
| `pgs-parser.test.ts`                            | PGS parser tests                               | Testing PGS decoding                                        |
| `vobsub-parser.ts`                              | VobSub / DVD SPU bitmap subtitle decoder       | Decoding DVD subtitles to timed RGBA cues                   |
| `vobsub-parser.test.ts`                         | VobSub parser tests                            | Testing SPU decoding                                        |
| `playlist-utils.ts`                             | Server playlist utilities                      | Building playlist features                                  |
| `provider-config.ts`                            | Provider configuration helpers                 | Configuring providers                                       |
| `rating-utils.ts`                               | Rating calculation utilities                   | Calculating ratings                                         |
| `rating-utils.test.ts`                          | Rating utility tests                           | Testing rating logic                                        |
| `section-builder.ts`                            | Page section builder utility                   | Building page sections                                      |
| `string-utils.ts`                               | String manipulation utilities                  | Manipulating strings                                        |
| `string-utils.test.ts`                          | String utility tests                           | Testing string logic                                        |
| `subtitle-sanitizer.ts`                         | WebVTT subtitle sanitization                   | Sanitizing subtitles                                        |
| `synthetic-iframe.ts`                           | Synthetic iframe generation                    | Generating iframes                                          |
| `tmdb-composite-key.ts`                         | TMDB composite key (provider_id + media_type)  | Using TMDB composite keys                                   |
| `typed-response.ts`                             | Typed Response helpers                         | Building typed responses                                    |
| `universal-id.ts`                               | Universal media ID utilities                   | Using universal IDs                                         |
| `user-watch-history.ts`                         | Watch history utilities                        | Working with watch history                                  |
| `webvtt-parser.ts`                              | WebVTT subtitle parser                         | Parsing WebVTT subtitles                                    |
| `webvtt-parser.test.ts`                         | WebVTT parser tests                            | Testing WebVTT parsing                                      |
| `widget-guard.ts`                               | Widget access guard                            | Protecting widget endpoints                                 |
