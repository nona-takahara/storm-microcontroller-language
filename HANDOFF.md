# v0.9.0 Refactor Handoff

`REFACTOR_PLAN_v0.9.0.md` に対して、既存コミットで実施済みだった公開前クリーンアップに加え、今回の作業では JSON スキーマ検証ヘルパーの共通化（§3.1）を追加実施しました。

## 今回追加で実施したこと

- `src/core/shared/json-schema-helpers.ts` を新設し、JSON object/array/string/boolean/number/integer/vector2 の低レベル検証を共通化しました。
- `sw-mcl` / `project.json` / `definitions` / `behavior-notes` の各パーサーは、既存のエラー型とエラーメッセージを保つ薄いローカルラッパー経由で共通ヘルパーを使うようにしました。
- `pnpm check` で TypeScript 型チェックが通ることを確認しました。

## 未実施・次担当者への注意

- §4 の診断型統一は一部土台（`src/core/diagnostics.ts` と CLI/MCP フォーマッタ共有）が既に入っていますが、`IrProgramMetadata.warnings`、`xml-tree.ts`、`importers/xml.ts` にはまだ `string[]` / importer 固有 warning 型が残っています。
- §5 のエラー伝播規約は完全統一されていません。CLI のトップレベル try/catch とファイル I/O 診断化は再確認してください。
- §6 の `IrNode` 型付きフィールド昇格、§3.4〜§3.7 の XML importer/exporter/layout 周辺の共通化、§8 の MCP `spec` / `layout_dsl` tool 追加は未実施です。
- 既存の `REFACTOR_HANDOFF_v0.9.0.md` は、ユーザー指示に従って削除し、この `HANDOFF.md` に置き換えました。
