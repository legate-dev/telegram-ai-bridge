// GeminiBackend was migrated from execFile (one-shot, -o json) to
// spawn + readline (--output-format stream-json, AsyncGenerator).
//
// The old line-by-line parse fallback for the `text` field no longer exists —
// the new backend always parses structured stream-json events from the CLI.
//
// All GeminiBackend integration tests now live in gemini-parser.test.js.
