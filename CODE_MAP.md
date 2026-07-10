# CODE_MAP.md

v0.9.0 リリース前に、このリポジトリのソースコードを初めて歩く人（人間でも AI エージェントでも）が迷わないようにするための地図です。「どこに何があるか」「どの順番で読むと理解しやすいか」に絞っており、コーディング規約や個々の挙動仕様は `CLAUDE.md` / `pnpm cli spec` を参照してください。

## 1. 3行で言うと

- Stormworks のマイコンセーブ XML ⇄ 人間が編集できる DSL（`.sw-net` / `.sw-mcl` / `project.json` / `*.lua`）を相互変換するツール。
- すべてのフォーマットは共通の中間表現 `IrProgram`（`src/core/ir.ts`）を経由する。Importer/Parser は `IrProgram` を作るだけ、Serializer/Exporter は `IrProgram` を消費するだけ。
- CLI（`storm-mcl`）と MCP サーバー（`storm-mcl-mcp`）は薄いラッパーで、実体はほぼ全て `src/core/` にある純粋関数群。

## 2. 読む順番のおすすめ

初見なら次の順で読むと全体像が繋がりやすいです。

1. `CLAUDE.md` — 全体アーキテクチャ表、コマンド一覧（前提知識）
2. `src/core/ir.ts` — 全パイプラインが経由する共通データ構造。まずこれの形を頭に入れる
3. `src/core/project-source.ts` — `StormworksProjectSource` というアプリ全体の「集約ルート」。import 解決・検証・XML 生成の呼び出し口が全部ここに集まる
4. `src/cli/main.ts` — 各コマンドが `project-source.ts` / `node.ts` の関数をどう呼んでいるかの実例
5. 変換したい方向に応じて `src/core/importers/xml.ts`（XML→IR）または `src/core/exporters/xml-tree.ts`（IR→XML）
6. `.sw-net` を触るなら `src/core/parsers/sw-net.ts` → `src/core/resolvers/sw-net.ts` → `src/core/serializers/sw-net.ts`
7. `src/mcp/server.ts` — MCP ツールの入出力形（CLI とほぼ1対1対応）

## 3. データフロー全体図

```
                      ┌─────────────────────────┐
                      │   src/definitions.json    │  ← 型番↔definitionId のマスタ
                      └─────────────┬─────────────┘
                                    │ loadBundledNodeDefinitions()
                                    ▼
Stormworks XML  ──[importers/xml.ts]──▶  IrProgram  ──[exporters/xml-tree.ts + xml.ts]──▶ Stormworks XML
                                    │
                                    │ buildProjectJsonDocument / serializeStormworksSwNet / buildStormworksSwMclDocument
                                    ▼
                      project.json + *.sw-net + *.sw-mcl + *.lua   (= StormworksProjectSource)
                                    │
                                    │ parsers/{project-json,sw-net,sw-mcl}.ts でファイル→メモリに戻す
                                    ▼
                       resolvers/sw-net.ts が use 文を辿ってモジュールグラフを解決
                                    │
                                    ▼
                       exporters/xml-tree.ts が解決済みグラフを Stormworks XML ツリーへ再構築
```

- 上段（XML⇄IR）と下段（DSLファイル⇄project-source）は別レイヤー。IR はインポート直後・エクスポート直前にしか登場しない一時表現で、DSL ファイルを直接読んでも IR は経由しない（`sw-net` パーサーは `SwNetDocument` という別の AST に直接パースする）。
- `layout-dsl`（ELK 自動配置）だけは上記フローの外側にある独立した機能で、`.sw-mcl` の座標だけを読み書きする（`src/core/layout/auto-layout.ts`）。

## 4. ディレクトリ別ガイド

### `src/core/` — ロジックの本体（Node.js非依存、ブラウザでも動く）

| ファイル | 役割 | 目安行数 |
|---|---|---|
| `ir.ts` | 中間表現 `IrProgram`/`IrNode`/`IrLink` の型定義のみ | 87 |
| `diagnostics.ts` | `Diagnostic`（error/warning/info）と `runToDiagnostics` 系ヘルパー。例外を投げるコードとエラーを値で返すAPI境界の変換点 | 134 |
| `project-source.ts` | **最重要ファイル**。`StormworksProjectSource` の定義、import解決の事前ロード、構造検証（`validateProjectSource`）、XML生成（`buildStormworksXml(Tree)FromProjectSource`）の入り口 | 1127 |
| `definitions/schema.ts` `loader.ts` `bundled.ts` | `src/definitions.json` のスキーマ検証・インデックス化（`NodeDefinitionRegistry`）。スキーマバージョンは `NODE_DEFINITIONS_SCHEMA_VERSION`（現在 "10"）で固定チェックされる | — |
| `behavior-notes/schema.ts` | `node-behavior-notes.json` / `stormworks-system-notes.json` の型検証 | — |
| `spec/gate-spec.ts` `tool-conventions.ts` | `storm-mcl spec` コマンドの中身。definitions + behavior-notes + ハードコードされたツール規約をマージするだけ | — |
| `importers/xml.ts` | **最大のファイルの一つ（1380行）**。Stormworks XML → `IrProgram`。project ノード・bridge・logic ノードの3層を読み分ける | 1380 |
| `exporters/xml-tree.ts` | **最大のファイル（1636行）**。解決済みモジュールグラフ → Stormworks XML の中間ツリー（importer のほぼ逆写像） | 1636 |
| `exporters/xml.ts` | `xml-tree.ts` の出力を `fast-xml-parser` の `XMLBuilder` で最終的な文字列に直列化するだけの薄い層 | 78 |
| `parsers/sw-net.ts` | `.sw-net` テキスト → `SwNetDocument`（module/port/inst/use文のAST）。手書き再帰下降パーサー | 882 |
| `parsers/sw-mcl.ts` | `.sw-mcl`（JSON）のパース・検証 | — |
| `parsers/project-json.ts` | `project.json` のパース・検証 | — |
| `resolvers/sw-net.ts` | `use` 文を辿って複数ドキュメントにまたがるモジュールグラフを解決。循環参照検出あり（`SwNetResolveError`） | — |
| `serializers/sw-net.ts` `sw-net-document.ts` `sw-net-shared.ts` | `IrProgram`/`SwNetDocument` → `.sw-net` テキストへの直列化 | 472+122+75 |
| `serializers/sw-mcl.ts` `project-json.ts` `submodule-layout.ts` | 各DSLファイルの直列化 | — |
| `layout/auto-layout.ts` | ELK (`elkjs`) を使った `.sw-mcl` 自動レイアウト計算。あえて `src/index.ts` からは re-export しない（elkjs が Node専用でブラウザバンドル非対応なため。issue #7 参照） | — |
| `shared/` | JSON検証ヘルパー・スカラー値の型強制・producer-index（net の最初の producer を引くための共有ロジック） | — |

### `src/infra/fs/` — Node.js 専用のファイルI/O層

`src/core/` は一切 `node:fs` を触らない。ファイルの読み書き・パス解決はすべてここに閉じ込められている。

- `text-file.ts` — UTF-8 読み書きの最小ラッパー
- `project-source-file-loader.ts` — `project.json` + entry `.sw-net`/`.sw-mcl` + 参照スクリプトをまとめて読み書きする、CLI/MCPの主な入り口
- `sw-net-file-loader.ts` — `use`/`script_ref` の相対パス解決（`node:path` の `resolve`/`dirname` ベース）
- `sw-net-layout-file-loader.ts`, `layout-dsl-runner.ts` — `layout-dsl` コマンド/MCPツール共通のランナー
- `bundled-*-loader.ts` — `dist/` にコピーされた `definitions.json` 等をロードする（`scripts/postbuild.mjs` が同梱）

**注意**: パス解決は素朴な `node:path.resolve()` ベースで、出力ディレクトリの外に出ないようにするサンドボックス化はしていない。CLIの利用者（またはMCP経由で呼ぶエージェント）が指定したパスをそのまま信頼するローカルツールという前提。

### `src/cli/main.ts` と `src/mcp/server.ts`

- どちらも `src/node.ts`（`index.ts` の re-export + `infra/fs` ヘルパー）だけをインポートし、`src/core/` を直接参照しない。ロジックを増やしたくなったら基本的に `core/` 側に書く。
- コマンド↔MCPツールの対応はほぼ1対1: `xml2dsl`↔`xml_to_dsl`、`dsl2xml`↔`dsl_to_xml`、`check-dsl`↔`check_dsl`、`typecheck-dsl`↔`typecheck_dsl`、`spec`↔`spec`、`layout-dsl`↔`layout_dsl`。片方に手を入れたらもう片方も確認する。

### ルート直下のJSON3点セット（`src/*.json`）

| ファイル | 何を表すか | 行数目安 |
|---|---|---|
| `definitions.json` | XML type番号 ↔ definitionId の構造マッピング（ポート・プロパティのXMLパス） | 1423 |
| `node-behavior-notes.json` | 各ゲートの実挙動メモ（`confidence`: verified/inferred/unconfirmed） | 1020 |
| `stormworks-system-notes.json` | ゲート単位でないプラットフォーム全体のメモ（tick rate、実行順序など） | 123 |

人間が編集する一次情報は `notes/gate-behavior/*.md`（日本語）で、上記JSONはそこから生成される想定（`NODE_BEHAVIOR_NOTES_GUIDE.md` 参照、ただし現時点でリポジトリに未コミット＝ドキュメント上の参照のみ）。

## 5. 主要な型・概念のチートシート

- **`IrProgram`**: `nodes`（`IrNode[]`）+ `links`（`IrLink[]`）+ `submodules` + `metadata`。`IrNode.layer` は `"project" | "submodule" | "logic"` の3層（project=マイコン外部ピン、submodule=モジュール境界ポート、logic=中身のゲート）。
- **`StormworksProjectSource`**: `project`（project.json） + `entryDocument`（entry の sw-net/sw-mcl/scripts） + `entryModuleId`。CLI/MCPが扱う実質的な「1プロジェクト」の単位。
- **`Diagnostic`**: `severity: error|warning|info` + `code` + `message` + `source`(文字列) + 任意の `documentId`/`path`。例外は境界（`runToDiagnostics`/`runAsyncToDiagnostics`）でこの形に変換されてから呼び出し側に返る。CLI/MCP はこれを一貫してフォーマットするだけ。
- **`NodeDefinitionRegistry`**: `definitions.json` をロード・インデックス化したもの。`byId` / `nodeByStormworksKey` / `componentByStormworksType` の3つのMapを持つ。
- **`SwNetResolutionResult`**: 複数ドキュメントにまたがる `use` 文をすべて解決した後のモジュールグラフ。`validateUseStatements` / `validateNetSignalConsistency`（`project-source.ts`）がこれを検査する。

## 6. 「これは意図的」な既知の設計判断（初見で驚きやすい点）

- `.sw-mcl` が存在しなくてもエラーにならない（`swMclOrigin: "generated"` のスタブ生成にフォールバック）。個別に配置できないポート/インスタンスだけ warning。
- `layout/auto-layout.ts` は `src/index.ts` から re-export されない（elkjsのブラウザ非対応のため、CLI専用）。
- `definitions.json` のスキーマバージョンは固定文字列比較でチェックされ、不一致は例外。将来スキーマを変えたら `NODE_DEFINITIONS_SCHEMA_VERSION` を上げ、`definitions.json` 側も揃える。
- 未知の XML `type` は `LOGIC_COMPONENT:<type>` として warning 付きでパススルーされる（インポート全体を失敗させない設計）。
- 66ゲート中24個は `node-behavior-notes.json` の `notes` が空（教科書的に自明なゲートと `PROPERTY_*` ウィジェット）。`spec` コマンドはこれを正直に「空である」と報告する。

## 7. 変更時に触りがちな組み合わせ

| やりたいこと | 触るファイル |
|---|---|
| 新しいXMLゲートに対応する | `definitions.json` に追記 → `importers/xml.ts` / `exporters/xml-tree.ts` が汎用的に処理できるか確認 → 未対応の型固有ロジックがあれば追加 |
| `.sw-net` の構文を拡張する | `parsers/sw-net.ts`（文法）→ `serializers/sw-net.ts`（直列化）→ `resolvers/sw-net.ts`（use解決が絡む場合） |
| 新しいCLIコマンド/MCPツールを追加する | `src/core/` に純粋関数を実装 → `src/node.ts` から re-export → `src/cli/main.ts` と `src/mcp/server.ts` 両方に薄いハンドラを追加 |
| ゲートの実挙動メモを直す | `notes/gate-behavior/*.md` → `node-behavior-notes.json` を再生成（現状は手動同期） |

## 8. 意図的にスコープ外のもの

- `definitions/sample/` は歴史的経緯で空のまま維持されている（CLAUDE.md参照）。
- 自動テストは無い。`pnpm cli` を実際に動かして確認するのが検証手段（CLAUDE.md冒頭に明記）。
