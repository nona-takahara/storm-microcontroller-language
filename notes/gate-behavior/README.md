# ゲート挙動メモ（ターン2 記入用）

Issue #5 / #4 向けの記入作業用ファイル一式です。書き方の詳細は
[`NODE_BEHAVIOR_NOTES_GUIDE.md`](../../NODE_BEHAVIOR_NOTES_GUIDE.md) を参照してください。

## 進め方

- 上から順番でなくてOK。知っているものから、興味のあるファイルから埋めてください。
- 1ファイルずつ完結しているので、「今日はこのファイルまで」と区切って進められます。
- 全部埋める必要はありません。分からないゲートはそのまま空欄で残してください。
- 特に優先度が高いのは、issue #4・#3で名指しされているゲートを含むファイルです（下記に印付き）。

## チェックリスト

- [ ] [`system.md`](./system.md) — Stormworks全体の仕様（7件）
- [ ] [`logic-flip-flop.md`](./logic-flip-flop.md) — ラッチ・フリップフロップ系（logic-flip-flop）（2件）（優先度高: issue #4で名指しされたゲートを含む）
- [ ] [`control.md`](./control.md) — 制御系（control）— タイマー・PID・カウンター・容量など（12件）（優先度高: issue #4で名指しされたゲートを含む）
- [ ] [`composite.md`](./composite.md) — Composite信号の合成・分岐系（composite）（5件）（優先度高: issue #4で名指しされたゲートを含む）
- [ ] [`composite-read.md`](./composite-read.md) — Composite信号の読み取り系（composite-read）（2件）（優先度高: issue #3で名指しされたゲートを含む）
- [ ] [`comparison.md`](./comparison.md) — 比較系（comparison）（3件）
- [ ] [`arithmetic.md`](./arithmetic.md) — 算術・関数系（arithmetic）（12件）
- [ ] [`logic-bool.md`](./logic-bool.md) — 論理ゲート系（logic-bool）（10件）
- [ ] [`value.md`](./value.md) — 定数系（value）（2件）
- [ ] [`property.md`](./property.md) — プロパティ系（property）— マイコンの外部UI要素（5件）
- [ ] [`composite-write.md`](./composite-write.md) — Composite信号の書き込み系（composite-write）（2件）
- [ ] [`debug.md`](./debug.md) — デバッグ表示系（debug）（2件）
- [ ] [`script.md`](./script.md) — スクリプト系（script）（1件）
- [ ] [`project.md`](./project.md) — プロジェクト入出力ピン系（project）（8件）

---

書き終わったら、Claudeに「ターン2終わったよ」と伝えてください。ターン3でこの内容を
構造化データに変換し、`docs/gate-spec/` 以下にゲートごとの仕様文書を生成した上で、
それを返すだけのCLIコマンド（`storm-mcl spec <ID>`）を実装します。
