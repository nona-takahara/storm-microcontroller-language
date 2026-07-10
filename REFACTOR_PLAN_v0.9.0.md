# v0.9.0 npm公開に向けたリファクタリング計画

## Context

このリポジトリ (`storm-microcontroller-language`) はまだ npm に一度も公開されていない (`package.json` の `version` は `0.1.0` のまま)。今回の v0.9.0 が事実上「世界に向けた最初のリリース」となるため、これ以降は互換性の約束が発生する。逆に言えば **今回だけは、このツール自身の過去バージョンとの互換性コードを気兼ねなく削除できる最後のタイミング** である。

4体の Explore サブエージェント (unused exports/dead files、parsers/serializers/exporters の重複、CLI/spec/MCP、後方互換シム) による並行調査と、アーキテクチャ判断が難しい3点について Fable 5 に意見を求めた結果、以下のリファクタリング項目が判明した。あわせてユーザーと以下の方針を確認済み:

- **ツール自身の後方互換コード**(`layout-json.ts` シム、CLI legacy エイリアス、`convert.ts`)→ **削除する**
- **Stormworksゲームが出力するXMLのうち、こちらがまだ仕様を把握しきれていない挙動差**(bridge states フォールバック、dynamic input count 補正)→ **両方とも残す**(データ欠損リスクがあり、後者は当初からの仕様のため)。**注意**: これらは「このツールにとっての旧形式」ではない。Stormworks自体の出力が絶対的な正解であり、単にこちらの解析・理解が追いついていない領域という位置づけなので、「legacy」「古い形式」という言葉遣いは避ける
- リファクタリング範囲は、デッドコード削除・重複統合だけでなく、`package.json`/公開設定の見直し、型・アーキテクチャの軽微な再設計、CLIコマンド体系の整理まで含める

実装は別エージェントに委ねる前提なので、本ドキュメントは「何を」「どこで」「どう直すか」を実行者が迷わない粒度で記述する。テストコードは存在しないため、各項目の完了後は `pnpm check` (`tsc --noEmit`) と `pnpm cli` での手動スモークテストが唯一の検証手段になる。

---

## 1. デッドコード削除(安全・確信度高)

以下はいずれもゼロ参照または不要なことが確認済み。機械的に削除してよい。

- `src/core/serializers/submodule-layout.ts`: `deriveSubmoduleCanvasOrigin` (5行目)、`subtractVector` (33行目) — 呼び出し元なし
- `src/infra/fs/sw-net-file-loader.ts`: `resolveSwNetFromFile`、`createFileSystemSwNetDocumentResolver`、`readRelativeSwNetTextFileSync` — 呼び出し元なし。実際の解決は `project-source.ts` / `project-source-file-loader.ts` 経由で行われている
- `src/infra/fs/text-file.ts`: `readUtf8TextFileSync` — 唯一の呼び出し元が上記の dead 関数なので芋づる式に不要
- `src/core/definitions/loader.ts`: `loadNodeDefinitionsDocument` (65行目) — 呼び出し元なし(使われているのは `loadNodeDefinitionsJson`)
- `src/core/exporters/xml-tree.ts`:
  - `collectPreferredLogicObjectIds` (282-298行目) — 呼び出し元なし
  - `tryParseTrailingNumber` (1616-1625行目) — 呼び出し元なし、かつ `sw-net-shared.ts` の `tryParseSwNetTrailingNumber` と実質同一コードの重複(§3参照)
  - `formatXmlNumber`(1599-1601行目)の `Number.isInteger(value) ? String(value) : String(value)` は三項演算子の両辺が同一で意味がない。`String(value)` だけに簡約
- `src/core/serializers/sw-net.ts`:
  - `formatNumber` (448-450行目) — 同上、両辺同一の三項演算子。`String(value)` に簡約
  - `collectOutputAssignments` の未使用引数 `node: IrNode` (271行目付近) — 削除
- `src/core/serializers/sw-mcl.ts`: `buildFallbackSwMclInstances` の未使用引数 `nodeById` (125行目) — 削除。呼び出し元 (55行目付近) の渡し方も修正
- `src/infra/fs/project-source-file-loader.ts:197-198`: ほぼ同一内容のコメントが2行連続している。1行に統合
- `package.json` の `devDependencies` から `@esbuild/linux-x64` を削除 — ビルドは `tsc` のみで esbuild は一切参照されていない

**この作業の一環として `tsconfig.json` に `noUnusedLocals: true, noUnusedParameters: true` を追加する**(Fable 5相談外だが Explore エージェントの提案どおり採用)。これにより上記のような未使用引数/変数の再発を `pnpm check` で機械的に検知できるようになる。追加後、`pnpm check` を実行し新たに検出される項目があれば合わせて対処する。

---

## 2. ツール自身の後方互換コードの削除(ユーザー確認済み)

- **`src/core/serializers/layout-json.ts`** ファイル全体を削除。旧 `layout-json` 命名から `sw-mcl` への移行時に作られた再エクスポート層で、内部の利用者はゼロ。`src/index.ts:16` の `export * from "./core/serializers/layout-json.js";` も削除
- **`src/core/pipeline/convert.ts`** ファイル全体を削除(`convertStormworksXmlToSwNet` とその型)。自称「薄い互換パイプライン」で内部の利用者はゼロ。`src/index.ts:23` の該当行も削除。`CLAUDE.md` のアーキテクチャ表 (Pipeline 行) からも記述を削除
- **`src/cli/main.ts` の legacy エイリアス削除**:
  - `switch` 文 (49-64行目) から `serialize-sw-net` / `build-xml` / `build-xml-tree` / `import-xml` の `case` を削除し、`xml2dsl` / `dsl2xml` / `dsl2xml-tree` のみ残す
  - `runImportXmlCommand` 関数(273-291行目付近)と、それ専用の `parseSingleInputPath` ヘルパー(744行目付近、他に使用者がいないか要確認)を削除
  - `printUsage()` (772-789行目付近) の `"Legacy / debug:"` セクションを削除
  - `parseXml2DslArgs` 内の死んだ `--layout` フラグ処理(678-680行目、受理するだけで何もしない)を削除。`printUsage()` に記載がないことも確認済み

---

## 3. 重複ロジックの統合

### 3.1 JSON スキーマ検証ヘルパーの共通化(最大の重複)

`expectRecord` / `expectArray` / `expectString` / `optionalString` / `expectFiniteNumber` / `expectInteger` / `parseVector2` などが、エラークラスだけ変えてほぼ同一実装で4箇所に存在:

- `src/core/parsers/sw-mcl.ts:83-144`(エラー: `SwMclParseError`)
- `src/core/parsers/project-json.ts:131-219`(エラー: `ProjectJsonParseError`)
- `src/core/definitions/schema.ts:362-421`(エラー: `NodeDefinitionsSchemaError`)
- `src/core/behavior-notes/schema.ts:156-183`(エラー: `BehaviorNotesSchemaError`)

**対応**: 新規ファイル `src/core/shared/json-schema-helpers.ts`(仮)を作り、エラーコンストラクタを引数に取るジェネリックな `expectRecord<E>(value, path, ErrorCtor)` 形式の共通実装に統合する。4ファイルはこの共通ヘルパーを import し、既存の局所エラークラスはそのまま維持(呼び出し側でエラークラスを渡すだけなので、公開されているエラー型やメッセージ文言は変えずに済む)。`parseVector2` も同様に統合。

### 3.2 識別子の自然順ソート・重複排除

正準実装は `src/core/serializers/sw-net-shared.ts:36-57`(`compareSwNetIdentifier` / `tryParseSwNetTrailingNumber`、既に export 済み)。以下を統合:

- `src/core/serializers/sw-net.ts:511-525` の `compareById`/`compareIdentifier` は `tryParseSwNetTrailingNumber` を再ラップしているだけなので、`compareSwNetIdentifier` を直接呼ぶよう置き換え(10行程度削除)
- `src/core/serializers/project-json.ts:317-343` は `compareIdentifier` と独自の `tryParseTrailingNumber` を丸ごと再実装している。`sw-net-shared.ts` から `compareSwNetIdentifier` を import して置き換え
- `src/core/exporters/xml-tree.ts:1616-1625` の `tryParseTrailingNumber` は §1で削除済みなのでここでは対応不要(重複していた元自体が消える)

### 3.3 識別子クオート判定の共通化

`src/core/serializers/sw-net.ts:373-375` の `formatBareIdentifier` と `src/core/serializers/sw-net-document.ts:119-121` の `formatPortName` が同じ正規表現 `/^[A-Za-z_][A-Za-z0-9_]*$/` でクオート要否を判定している。`sw-net-shared.ts` に `IDENTIFIER_PATTERN` 定数(または `quoteIfNeeded(value)` 関数)を1つ追加し、両方から参照する。

### 3.4 スカラー値の型強制ロジック統合

`src/core/importers/xml.ts:1091-1124` の `coerceScalarValue` と `src/core/serializers/sw-net.ts:400-445` の `coerceDslScalarValue` は、`"true"|"1"` / `"false"|"0"` の真偽値ヒューリスティックを含め、ほぼ同じ変換規則を型シグネチャだけ変えて実装している。共通ヘルパーとして1箇所(例: `src/core/shared/scalar-coercion.ts`)にまとめ、`DefinitionValueType` を受け取る形に統一する。

### 3.5 XML インポータ内の座標読み取りヘルパー統合

`src/core/importers/xml.ts:1266-1305` の `readProjectPosition` / `readBridgePosition` / `readLogicPosition` は、ネストされた position レコードを読んで `x` と `y`/`z` のいずれかを既定値0で返す、という同一パターンの3実装。位置レコードのパスと軸キーをパラメータ化した1つの `readPosition(record, positionKey, yAxisKey)` に統合する。

### 3.6 リンクのソース解決ロジック統合

`src/core/importers/xml.ts` 内の `importLogicLinks`(583-597行目)と `importProjectAndBridgeLinks`(674-688行目)が、`logicNodes.get(sourceRawId)` → 見つからなければ `ensureSubmoduleInputPort(...)` にフォールバック → `from` エンドポイント構築、という同一の15行程度のブロックを重複させている。`resolveLinkSourceEndpoint(sourceRawId, logicNodes, submodulePorts, definitions, program, warnings, record)` として1関数に切り出し、両方の呼び出し元から使う。

### 3.7 "first producer wins" ロジックの共有

`src/core/layout/auto-layout.ts:136-155`(`buildNetProducerIndex`)と `src/core/exporters/xml-tree.ts:781-806` が、それぞれ異なる入力形状(`SwNetStatement[]` vs `LogicInstanceContext[]`)に対して同一アルゴリズム(出力を走査し、2つ目の producer が出たら警告してスキップ)を実装している。前者のコメントで既に重複が自覚されている。両方の入力形状をアダプトできる共通関数に切り出すか、少なくとも共通のコア判定ロジック(1つの net 名につき producer は1つまで、という判定部分)だけでも共有関数に抽出する。

### 3.8 「entry submodule 選択」ロジックの統合

- `src/infra/fs/project-source-file-loader.ts:267-286` の `selectEntrySubmodule`(`preferredModuleId` オプション対応)
- `src/infra/fs/sw-net-layout-file-loader.ts:112-118` の `selectEntrySubmodule`(オプションなし)

同じ「id === "main" → name === "main" → 唯一のサブモジュールにフォールバック」規則を重複実装しており、片方には機能差(`preferredModuleId`)がある。`preferredModuleId` を省略可能にした1実装に統合し、`src/infra/fs/` 内の共有モジュールに置く。

### 3.9 ENOENT 判定の統合

`src/infra/fs/sw-net-layout-file-loader.ts:120-122` の `isFileNotFoundError` ヘルパーと、`src/infra/fs/project-source-file-loader.ts:254-260` の `readSwMclTextOrStub` 内にインラインで書かれた同等の `error.code === "ENOENT"` 判定を統合。前者のヘルパーを共有モジュールに移し、後者から呼ぶ。

### 3.10 診断行フォーマットの統合

`src/cli/main.ts:754-769` の `printDiagnostics` と `src/mcp/server.ts:238-246` の `formatDiagnostics` が同じ `[severity] code (documentId:path): message` 形式を独立実装している。§4の診断統一作業の一環として、共有の `formatDiagnostic(d): string` 関数を1箇所(例: `src/core/diagnostics.ts` または `node.ts` 経由で公開するユーティリティ)に置き、CLI・MCP 両方から使う。

---

## 4. 診断・警告データ型の統一(Fable 5 相談結果を採用)

現状、以下3種の異なる形が並存し、上位層 (`project-source.ts`) が変換のためだけのアダプタコードを大量に抱えている:

1. `StormworksXmlImportWarning { code, message, path?, severity? }` — `src/core/importers/xml.ts:33-39`
2. 素の `string[]` — `IrProgramMetadata.warnings`(`src/core/ir.ts:42`)および `xml-tree.ts` のほぼ全関数が引き回している `warnings: string[]`
3. `StormworksLibraryDiagnostic { severity, code, message, documentId?, path?, source }` — `src/core/project-source.ts:86-93`

**方針**: 最も情報量の多い (3) をベースに、`source` を必須フィールドとした単一の `Diagnostic` 型に統一する:

```ts
interface Diagnostic {
  severity: "error" | "warning" | "info"; // 必須
  code: string;                            // 必須
  message: string;                         // 必須
  source: string;                          // 必須。"xml-importer" / "exporter" / "sw-net-parser" など、層を示す
  documentId?: string;                     // 任意
  path?: string;                           // 任意
}
```

**移行方針(Fable 5 推奨: 生成元を変換する、境界1点で変換しない)**:
- `IrProgramMetadata.warnings` および `xml-tree.ts` の全関数の `warnings: string[]` パラメータ/返り値を `Diagnostic[]` に置き換える。`warnings.push(msg)` の呼び出し箇所を `warnings.push({ severity: "warning", code, message, source: "exporter" })` へ機械的に変換(コードが未定のものは汎用コード `EXPORT_WARNING` を仮に割り当ててよい)
- `StormworksXmlImportWarning` を削除し、統一 `Diagnostic` 型に一本化(構造がほぼ同じなので実質的に型エイリアス+ `source` 追加程度の変更)
- 上記2つが完了すれば `src/core/project-source.ts` 内の `.map()` による (1)→(3)、(2)→(3) 変換コード(`createWarningDiagnostic`/`createInfoDiagnostic`/`createErrorDiagnostic` の呼び出し箇所、211-217行目、359-363行目、413-417行目付近)は不要になり削除できる
- 統一 `Diagnostic` 型は `src/core/ir.ts` または新規 `src/core/diagnostics.ts` に定義し、`index.ts` で公開する
- §3.10 の `formatDiagnostic` はこの型を前提に1箇所実装する

この作業は影響範囲が広いため、他のリファクタリング項目より後回しにし、独立したコミット/PRの単位として切り出すことを推奨する。

---

## 5. エラー伝播方式の統一(Fable 5 相談結果を採用)

**現状の3層混在**:
- 低レベルスキーマ検証層(`definitions/schema.ts`, `behavior-notes/schema.ts`, パーサ群)は独自 `Error` サブクラスを `throw`
- 中間層(importer/exporter)は警告配列に積んで処理継続(ベストエフォート)
- `project-source.ts` が両方を try/catch で診断に変換
- CLI の `xml2dsl` / `import-xml` (`runXml2DslCommand`, `runImportXmlCommand`) は `readUtf8TextFile` を直接呼んでおり try/catch がないため、ファイル未検出などの Node.js 生エラーが整形されずにユーザーに見える(他コマンドは `[error] CODE (path): message` の整形済み表示)

**採用する規約**(Fable 5 提案どおり):
> ユーザーの不正な入力(壊れたXML/DSL/JSON、ファイル不足、未知のゲート型)に起因しうる失敗は、検知した層で `Diagnostic` として返す結果に含め、上位に `throw` しない。部分的に成功しうる関数は `{ value?, diagnostics }` を返す。`throw` はプログラマの不変条件違反や、内部スキーマバリデータのような「直近の呼び出し元が捕捉して `Diagnostic` に変換することが保証されている」箇所に限定する。CLI (`main.ts`) のトップレベルには唯一の try/catch を置き、そこに漏れてきた例外は `INTERNAL_ERROR` という `Diagnostic` に変換して非ゼロ終了する。

**具体対応**:
- 低レベルスキーマ検証層の `throw` はそのまま残してよい(バリデータとして正しい設計)。ただし呼び出し元で必ず捕捉すること
- `project-source.ts` に散らばる try/catch を、共通ヘルパー `runToDiagnostics(fn, source): { value?, diagnostics }` に集約する(スキーマバリデータ呼び出し箇所すべてに適用)
- **即座に直すべきバグ**: `runXml2DslCommand` / `runImportXmlCommand`(`src/cli/main.ts:85`, `282`付近)の `readUtf8TextFile` 直接呼び出しを、上記 `runToDiagnostics` または同等のラップ経由に変更し、ENOENT などが `FILE_NOT_FOUND` 診断として他コマンドと同じ整形で表示されるようにする
- `src/mcp/server.ts` は既に1箇所の try/catch (102-118行目) で全て `errorResult` にまとめているが、§4 の統一 `Diagnostic` 型・§3.10 のフォーマッタ導入後は CLI と同じ表示ロジックを共有できるようにする

---

## 6. IrNode の layer 二重管理を解消(Fable 5 相談結果を採用)

`src/core/ir.ts:17-24` の `IrNode` は `layer: IrNodeLayer` という型付きフィールドを持つが、`src/core/importers/xml.ts` の全ノード構築箇所(251/264, 418/424, 465/476, 752/761行目付近)で `properties.layer` にも同じ値をコピーしている。これは `src/core/serializers/sw-net.ts:197` のジェネリックなプロパティ走査(`collectAttributeAssignments`)がハードコードされた `hiddenKeys = new Set(["objectId", "stormworksType", "layer", "script"])` でこれらを除外するためだけの、ファイル間の暗黙の契約になっている。

**採用する方針(Fable 5 提案 (b))**: `objectId` / `stormworksType` / `componentId` / `projectNodeId` / `script` を `IrNode` の型付きオプショナルフィールドに昇格させ、`properties` は「本当に動的なゲート固有プロパティのみ」を保持するようにする。これにより:
- インポータ側で `layer` を `properties` に二重コピーする処理を削除
- シリアライザ側の `hiddenKeys` によるフィルタも不要になる(型で表現されたフィールドは `properties` を汎用スキャンする対象に含まれなくなるため)
- 未知のプロパティは従来どおり `properties` を素通りする

`IrNode` の変更なので、影響箇所(インポータでの構築、エクスポータでの読み出し、シリアライザでの走査)を一括で確認しながら進める必要がある。§4の `Diagnostic` 統一と並んで影響範囲が広いため、独立した作業単位として扱うことを推奨。

**あわせて**: `IrSourceRef`(`ir.ts:33-36`)とノード/リンク/サブモジュールの `source?` フィールド、`IrProgramMetadata.sourceFormat` は全箇所で書き込まれるだけで読み出し側が存在しない(write-only)。将来の診断向け位置情報として意図的に残すのか、現時点で不要なら削除するのか要判断——ただし壊れやすい変更ではないため、この計画では「残し、コメントで『現状未使用、将来の診断用に予約』と明記する」ことを最小対応として推奨する(削除してもよいが、実装担当者の判断に委ねる)。

---

## 7. bundled JSON ローダーの共通化とスキーマバージョン検証の穴を修正

`src/infra/fs/bundled-definitions-loader.ts`(19行)と `bundled-behavior-notes-loader.ts`(37行)が、`import.meta.url` からのパス解決・`getBundledXPath()`・`loadBundledX()` という同一パターンを3つの bundled JSON アセット(`definitions.json`, `node-behavior-notes.json`, `stormworks-system-notes.json`)分だけ個別実装している。

**さらに重要なバグ**: `src/core/definitions/loader.ts:26-30` は `schemaVersion !== NODE_DEFINITIONS_SCHEMA_VERSION` を検証して不一致なら throw するが、`src/core/behavior-notes/schema.ts` で定義されている `NODE_BEHAVIOR_NOTES_SCHEMA_VERSION`(5行目, `"1"`)と `STORMWORKS_SYSTEM_NOTES_SCHEMA_VERSION`(6行目, `"1"`)はどこからも参照・比較されていない。`parseNodeBehaviorNotesDocument`/`parseStormworksSystemNotesDocument`(59-90行目)は `schemaVersion` を読み取るだけで検証しない。

**対応**: `src/infra/fs/` に汎用 `loadBundledJson<T>(relativeFileName: string, parse: (raw: unknown) => T, expectedSchemaVersion?: string): Promise<T>` ヘルパーを新設し、3つの bundled ローダーをこれに置き換える。この際 `node-behavior-notes.json` と `stormworks-system-notes.json` の読み込みでも `expectedSchemaVersion` チェックを有効化し、`definitions.json` と同様に不一致なら明示的にエラーにする(現状のサイレント許容を修正)。

---

## 8. MCP サーバーの整備

`src/mcp/server.ts` は動作する実装(スキャフォールドではない)だが、以下の点でリリース品質に達していない:

- `Server({ name: "storm-mcl", version: "0.1.0" }, ...)`(22行目)が `package.json` の `version` と無関係にハードコードされている。バージョンアップの度に手動更新が必要な状態を解消するため、`package.json` から読み込む(`import packageJson from "../../package.json" with { type: "json" }` 等、`resolveJsonModule` は既に有効)ように変更
- CLI は8コマンド(xml2dsl, dsl2xml, dsl2xml-tree, check-dsl, typecheck-dsl, layout-dsl, spec, 他)を持つのに対し MCP は4ツール(`xml_to_dsl`, `dsl_to_xml`, `check_dsl`, `typecheck_dsl`)のみで、特に `spec` ツールが欠けている。`CLAUDE.md:55-56` によれば `spec` はAIエージェント向けの参照情報を意図しているため、MCPサーバーにこそあるべき機能。`spec` ツール(および必要なら `layout_dsl`)の追加を検討する
- ツール説明・レスポンス文言が日本語決め打ち(`変換が完了しました` 等、31, 38, 41, 50, 57, 60, 69, 75, 84, 90行目)。CLI側は英語。npm公開してグローバルなMCPクライアントから使われる想定なら英語に統一するか、最低限 README で「日本語で応答します」と明記する
- README/CLAUDE.md に MCP サーバー (`storm-mcl-mcp`) についての記述が一切ない。ドキュメント追加が必要

---

## 9. CLI ドキュメントの整合性

- `layout-dsl` コマンド(`main.ts:331-418`、`--module` / `--document` / `--all-submodules` / `--force`/`--regenerate` / `--dry-run`/`--check` / `--grid-size` 対応の本格機能)が `CLAUDE.md` の「CLI usage」コードブロック(15-23行目)と `README.md` の日本語使用例のどちらにも記載がない。両方に追記する
- `main.ts:85`(`runXml2DslCommand`)などのファイル書き込み確認メッセージでバックスラッシュ (`\\`) をハードコードしている箇所があり、他コマンドの OS ネイティブ表示と不整合。フォワードスラッシュ/`console.error(\`Wrote ${path}\`)` の形に統一する

---

## 10. package.json / 公開準備

- `"version": "0.1.0"` → `"0.9.0"` に更新
- `"description": "Stormworks microcontroller conversion tool skeleton"` の `"skeleton"` という表現は初期プロトタイプ時代の名残でリリース向けにふさわしくない。実態(Stormworks マイクロコントローラXMLとDSLの相互変換ツール)を表す説明文に書き換える
- `@esbuild/linux-x64` の削除(§1で対応済み)
- `pnpm build` → `npm pack --dry-run` を実際に実行し、`dist/` の構成(`index.js`, `node.js`, `cli/main.js`, `mcp/server.js`, 3つの bundled JSON)が `files`/`exports`/`bin` フィールドと一致することを目視確認する(これまで `dist/` が生成されたことがない状態のため、静的な設定の突き合わせだけでなく実ビルドでの確認が必須)

---

## 11. 未対応/未確定事項(実装担当者への申し送り)

- `test/CHUSO1800_Traction.xml` はどこからも参照されていない可能性が高い(テストランナー自体が存在しない)。手動スモークテスト用フィクスチャの可能性があるため、削除せず維持を推奨。README/CLAUDE.md に「手動検証用サンプル」である旨を一言添えてもよい
- `getBundledDefinitionsPath` / `getBundledNodeBehaviorNotesPath` / `getBundledStormworksSystemNotesPath` / `StormworksSwNetSerializer` クラスは内部利用者がいないが、`index.ts`/`node.ts` で意図的に公開している可能性がある(ライブラリとしての利用を想定した公開API)。README に「CLIだけでなくライブラリとしてもimport可能」という記載がなければ、公開意図を維持するか絞るかはユーザー判断が必要
- `findCompatibleComponentDefinition` / `extractCompatibleStormworksType`(`src/core/definitions/loader.ts:97-137`)は「互換」という名前だが実際は未知/未収録のゲート型をDSLで往復させるための現行の主要機構であり、削除対象ではない(§2の削除対象とは別物)。誤って削除しないよう明記しておく
- `src/core/importers/xml.ts` 内のコメントの言葉遣い修正(機能変更なし、コメントのみ): `collectProjectBridgesFromLegacyStates`(295行目・349行目付近のコメント)や `reconcileDynamicInputCount`(917-918行目付近のコメント、"legacy edits" という表現)は、いずれも「このツールにとっての古い/legacyな形式」ではなく「Stormworks自体の出力のうち、こちらがまだ解析しきれていない挙動」を扱うコードである。Stormworksの出力は常に絶対的な正解であり、このツール側の理解不足という位置づけを反映し、コメント中の "legacy" という単語を "not-yet-understood" 相当の表現(例: "an alternate bridge-state shape we haven't fully characterized yet" 等)に書き換える

---

## 検証方法

1. `pnpm check`(`tsc --noEmit`)が全ての変更後にエラーなく通ること。`noUnusedLocals`/`noUnusedParameters` を有効化した状態でも確認する
2. `pnpm build` を実行し `dist/` が正しく生成されること、`npm pack --dry-run` で `files`/`bin`/`exports` の内容を確認する
3. `pnpm cli spec --list` および `pnpm cli spec <definitionId>` が既存と同じ出力になることを確認(診断型統一・重複整理で壊れやすい経路)
4. `pnpm cli xml2dsl test/CHUSO1800_Traction.xml --out-dir <tmp>` → `pnpm cli dsl2xml <tmp>/project.json --out <tmp>/roundtrip.xml` の往復変換で、変換結果のXMLが意味的に元と一致すること(diffで大きな差分が出ないこと)を目視確認する。特に bridge states フォールバック・dynamic input count 補正(未知のStormworks挙動へ対応するコード、Contextおよび§11参照)は変更しないため既存の回帰がないことの確認が目的
5. `pnpm cli check-dsl` / `pnpm cli typecheck-dsl` を出力先の `project.json` に対して実行し、エラー・警告メッセージのフォーマットが(§4/§5の統一後も)想定どおり整形されていること(特に存在しないファイルを指定した際のエラー表示が全コマンドで統一されていること)を確認する
6. MCP サーバーを変更した場合は `pnpm mcp` で起動し、`spec` ツール追加時は実際にツール呼び出しをして応答を確認する
