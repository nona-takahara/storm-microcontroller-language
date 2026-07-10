# v0.9.0 リファクタリング申し送り

今回の作業では `REFACTOR_PLAN_v0.9.0.md` のうち、安全に切り出せる公開前クリーンアップを優先した。環境上 `pnpm` が Corepack 経由で registry にアクセスできず、依存関係の取得・型チェック・ビルドを実行できなかったため、影響範囲が大きい診断型統一、`IrNode` 型再設計、XML importer/exporter の大規模共有化は未実施。

## 実施済み

- ツール自身の後方互換シムを削除: `layout-json.ts`, `convert.ts`, CLI legacy alias/debug command。
- `package.json` を v0.9.0 向けに更新し、直接依存していない `@esbuild/linux-x64` を削除。
- `tsconfig.json` に `noUnusedLocals` / `noUnusedParameters` を追加。
- 明らかな dead export / 未使用引数 / 重複ソート・識別子クオート処理の一部を整理。
- bundled JSON loader を共有化し、behavior-notes/system-notes の schemaVersion もロード時に検証するようにした。
- MCP server version を `package.json` 由来にし、ツール説明・応答文言を英語へ寄せた。
- CLI/README/CLAUDE の legacy 記述や `layout-dsl` 記載漏れを修正。
- XML importer のコメントから「legacy」という誤解されやすい表現を除去。

## 未実施・次の担当者への注意

- `pnpm check` / `pnpm build` / `npm pack --dry-run` は依存関係未取得のため未実行。最優先で実行し、`noUnused*` で新たに出るエラーを直すこと。
- `src/core/diagnostics.ts` の新設と `Diagnostic` 型統一は未実施。CLI/MCP の診断フォーマット共有もこの作業と一緒に行うのがよい。
- `IrNode.properties` から `objectId` / `stormworksType` / `script` などを型付きフィールドへ昇格する設計変更は未実施。
- JSON schema helper 共通化、scalar coercion 共通化、XML importer 内の position/link-source helper 共通化、producer index 共通化は未実施。
- MCP の `spec` / `layout_dsl` tool 追加は未実施。今回の変更では文言と version 読み込みのみ対応。

## 環境メモ

`pnpm check` は Corepack が `https://registry.npmjs.org/pnpm/-/pnpm-10.28.2.tgz` を取得しようとして proxy 403 で失敗した。`node_modules` も存在しないためローカルの `tsc` で代替確認できなかった。
