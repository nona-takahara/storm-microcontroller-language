# v0.9.0 Refactor Handoff

古い `HANDOFF.md` は読み取り後、ユーザー指示に従って削除し、本ファイルを新しい申し送りとして作り直しました。

## 今回実施したこと

- `REFACTOR_PLAN_v0.9.0.md` §3.7 に従い、auto-layout と XML tree exporter に重複していた "first producer wins" の重複 net 判定を `src/core/shared/producer-index.ts` の `registerFirstProducer(...)` に切り出しました。
- 呼び出し側の入力形状や warning 文言は維持し、重複 net を検出したら既存 producer を残して後続 producer を無視する判定のみを共有化しました。
- `pnpm check` は通過済みです。

## 未実施・次担当者への注意

- §3.6 の `resolveLinkSourceEndpoint` はユーザー指示どおり別ブランチ実施済みとして触っていません。
- §4 の診断型統一は一部土台（`src/core/diagnostics.ts` と CLI/MCP フォーマッタ共有）が既に入っていますが、`IrProgramMetadata.warnings`、`xml-tree.ts`、`importers/xml.ts` にはまだ `string[]` / importer 固有 warning 型が残っています。
- §5 のエラー伝播規約は完全統一されていません。CLI のトップレベル try/catch とファイル I/O 診断化は再確認してください。
- §6 の `IrNode` 型付きフィールド昇格、§8 の MCP `spec` / `layout_dsl` tool 追加は未実施です。
