# ゲート挙動ナレッジ ひな形ガイド

Issue #5（仕様引きCLIサブコマンド）・Issue #4（未文書化のゲート挙動）向けの3ターン作業のうち、
このガイドは **ターン1の成果物** です。

- `src/node-behavior-notes.json` — 個々のゲート/ノード（66種類）ごとの挙動メモのひな形
- `src/stormworks-system-notes.json` — 特定のゲートに紐づかない、Stormworks全体に共通する仕様のひな形（tick周期・composite信号のレイアウト等）

このガイドを読んだ上で、**ターン2ではこの2つのJSONファイルの `notes` 配列を日本語で埋めてください。**
ターン3でClaudeが内容を整形し、`storm-mcl spec` コマンド（Issue #5）としてAIエージェントが直接参照できる形にします。

---

## なぜこのファイルが必要か

このリポジトリのIssue履歴（#1, #3, #4, #10, #11, #13, #14, #15）を振り返ると、AIエージェント（Claude）は
何度も同じパターンでつまずいています。

> ノードの入出力ポート・プロパティの型は `src/definitions.json` を読めば分かる。
> しかし **「実際にStormworks上でどう動くか」は definitions.json に書かれていない。**
> その結果、実機XMLサンプルを1件ずつ diff して推測する、という高コストな調査を毎回やり直すことになる。

このナレッジソースは、その「毎回やり直している調査」を一度だけ人間の手で確定させ、
AIが二度と同じ調査をしなくて済むようにするためのものです。

---

## AIが特に調べがちな情報カテゴリ

過去のIssueで実際に発生した「AIが調べざるを得なかった情報」を、カテゴリとして整理しました。
`focusHints` フィールドには、各ゲートについてこのカテゴリのうち関連しそうなものを自動生成で
事前に書き込んであります（ターン2で記入する際の出発点として使ってください。的外れなら無視してOKです）。

| カテゴリ | 内容 | 実例（Issue） |
|---|---|---|
| 初期状態 (initial-state) | マイコン起動直後・電源投入直後の出力値 | #4 (SR_LATCH) |
| 同時入力時の優先順位 (priority) | Set/Reset等が同時に真になった場合、どちらが勝つか | #4 (SR_LATCH, MEMORY_REGISTER) |
| 時間的挙動の詳細 (timing) | 充放電・遅延・積分などの時定数と、実際の応答曲線 | #4 (CAPACITOR) |
| 真理値表 (truth-table) | 多入力ゲートの全入力パターン→出力の対応 | #4 (COMPOSITE_SWITCHBOX) |
| チャンネル/インデックスの省略時挙動 (channel-semantics) | `channel` 等のプロパティが未指定(null)の場合の実際の扱い | #3 (COMPOSITE_READ_*) |
| XMLシリアライズの省略規則 (serialization-omission) | デフォルト値・0値がXML上で省略されるかどうかの規則、`text`/`value`のどちらが正か | #1, #11, #13 |
| ラウンドトリップでの消失リスク (round-trip-loss) | count等の付随属性が欠落した場合に、変換後にStormworks側が配線を破棄する等 | #10, #14, #15 |
| UI状態と実挙動の区別 (ui-only-state) | ゲーム内エディタの見た目だけに影響し、機能的な挙動には影響しない差分かどうか | #11 |
| 境界値・エッジケース (edge-case) | 0除算、オーバーフロー、NaN、未接続ポート等の扱い | — |

これらのカテゴリはあくまで目安です。`notes` に書き込む際、`category` フィールドに上記の英語タグ
（`initial-state` / `priority` / `timing` / `truth-table` / `channel-semantics` /
`serialization-omission` / `round-trip-loss` / `ui-only-state` / `edge-case` / `other`）
を使うと、ターン3での自動整形がしやすくなります（必須ではありません）。

---

## `src/node-behavior-notes.json` の構造

```jsonc
{
  "schemaVersion": "1",
  "generatedFrom": "src/definitions.json (schemaVersion 10)",
  "entries": {
    "SR_LATCH": {
      "displayName": "SR Latch",       // 参考情報。definitions.jsonから自動生成、編集不要
      "category": "logic-flip-flop",   // 参考情報。編集不要
      "status": "todo",                // 記入したら "done" に変更してください（未確認事項が残るなら "todo" のまま）
      "relatedIssues": [4],            // 参考情報。関連する既知のIssue番号
      "focusHints": ["..."],           // 参考情報。記入時に確認してほしい観点（自動生成の下書き）
      "notes": []                      // ★ここにターン2で日本語の情報を追記する
    }
  }
}
```

### `notes` 配列に追記する1件の形式

```jsonc
{
  "category": "priority",              // 上記カテゴリタグ（任意）
  "text": "リセットとセットが同時に真になった場合、リセットが優先される。電源投入直後の出力はfalse固定。",
  "confidence": "verified",            // "verified"（実機/公式資料で確認済み） | "inferred"（推測・状況証拠から） | "unconfirmed"（未確認・要検証のメモ）
  "source": "実機テスト（2026-07-xx、CHUSO1800にて確認）" // 任意。どうやって確認したか・出典URL等
}
```

- `text` 以外のフィールドは省略可能です。分かる範囲で構いません。
- 1つのゲートに対して複数の `notes` エントリを追加してもOKです（カテゴリごとに分ける等）。
- 分からない・確認できなかった項目は無理に埋めず、`status: "todo"` のままで構いません。空欄のまま残すことも情報です（「未確認」という記録になります）。

---

## `src/stormworks-system-notes.json` の構造

個々のゲートではなく、Stormworksマイコン全体に関わる仕様（tick周期、composite信号のチャンネル数、
コンポーネント間の実行順序、LUAスクリプトAPIなど）をここに書きます。構造は `node-behavior-notes.json`
とほぼ同じで、`entries` のキーがゲートIDではなくトピックID（`tick-rate`, `execution-order` 等）になっています。

これは今回の指摘（「Stormworks特有の仕様もコマンドで引けるようにすべき」）を反映したもので、
ターン3の `spec` コマンドはゲート個別の情報とこの全体仕様の両方を検索・出力できるようにする予定です。

---

## ターン2でやること（あなた向け）

1. `src/node-behavior-notes.json` を開き、各ゲートの `focusHints` を参考にしながら分かる範囲で `notes` を埋める。
2. `src/stormworks-system-notes.json` も同様に埋める。
3. 特にIssue #4で名指しされている4つのゲート（`SR_LATCH`, `CAPACITOR`, `MEMORY_REGISTER`, `COMPOSITE_SWITCHBOX`）と、
   Issue #3の `COMPOSITE_READ_NUMBER` / `COMPOSITE_READ_BOOLEAN` の channel=null挙動は優先度高めです。
4. 全ゲートを埋めきる必要はありません。分かるものから、分かる範囲で構いません。JSON構文（カンマ・引用符）だけ壊さないよう注意してください。
5. 埋め終わったら教えてください。ターン3でClaudeが内容を検証・整形し、`storm-mcl spec` コマンドを実装します。
