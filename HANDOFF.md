# v0.9.0 Refactor Handoff

古い `HANDOFF.md` は読み取り後、ユーザー指示に従って削除し、本ファイルを新しい申し送りとして作り直しました。

## 今回実施したこと

- `REFACTOR_PLAN_v0.9.0.md` §3.4 に従い、XML importer と sw-net serializer に重複していたスカラー値の型強制ロジックを `src/core/shared/scalar-coercion.ts` に共通化しました。
- `REFACTOR_PLAN_v0.9.0.md` §3.5 に従い、XML importer 内の project / bridge / logic position 読み取り処理を `readPosition(...)` に集約しました。
- `REFACTOR_PLAN_v0.9.0.md` §3.8 と §3.9 に従い、entry submodule 選択と ENOENT 判定を `src/infra/fs/project-file-helpers.ts` に共通化し、project-source / layout-dsl のファイルローダーから利用するようにしました。
- `pnpm check` は通過済みです。

## 未実施・次担当者への注意

- §4 の診断型統一は一部土台（`src/core/diagnostics.ts` と CLI/MCP フォーマッタ共有）が既に入っていますが、`IrProgramMetadata.warnings`、`xml-tree.ts`、`importers/xml.ts` にはまだ `string[]` / importer 固有 warning 型が残っています。
- §5 のエラー伝播規約は完全統一されていません。CLI のトップレベル try/catch とファイル I/O 診断化は再確認してください。
- §6 の `IrNode` 型付きフィールド昇格、§3.6〜§3.7 の XML importer/exporter/layout 周辺の共通化、§8 の MCP `spec` / `layout_dsl` tool 追加は未実施です。
- `src/core/shared/scalar-coercion.ts` は importer の既存挙動を保つため、`null` を string に強制する場合は `"null"` にします。一方 serializer 側は DSL の `null` literal を維持するため `{ preserveNull: true }` を渡しています。この差を不用意に取り除かないでください。
