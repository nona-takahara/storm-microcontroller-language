# storm-microcontroller-language

Minimal TypeScript skeleton for a Stormworks microcontroller conversion tool.

## Current scope

- CLI entry point
- internal IR types
- node definitions schema and loader
- bundled `src/definitions.json`
- XML importer skeleton using `fast-xml-parser`
- `.sw-net` serializer skeleton
- XML export stub

## Structure

- `src/core`: pure conversion logic and interfaces
- `src/infra`: Node.js specific file I/O
- `src/cli`: CLI entry point
- `src/definitions.json`: bundled sample definitions
