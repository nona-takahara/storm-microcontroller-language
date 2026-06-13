# storm-microcontroller-language

Stormworks のマイコンセーブデータ（XML）を、人間が読み書きできる DSL 形式に相互変換するツールです。

## 概要

Stormworks からエクスポートした XML をテキスト形式の DSL に変換し、テキストエディタや Git で管理できるようにします。編集後は XML に戻してゲームに再インポートできます。

```
Stormworks XML  ──xml2dsl──▶  .sw-net / .sw-mcl / project.json
                ◀─dsl2xml──
```

## セットアップ

Node.js 18 以上と pnpm が必要です。

```bash
pnpm install
```

## 使い方

### XML → DSL（xml2dsl）

Stormworks からエクスポートした XML を DSL ファイル群に変換します。

```bash
pnpm cli xml2dsl <input.xml> --out-dir <出力ディレクトリ>
```

出力ディレクトリに以下のファイルが生成されます。

| ファイル | 内容 |
|---|---|
| `main.sw-net` | ノードの定義・接続グラフ |
| `main.sw-mcl` | Lua ロジックノードの参照 |
| `scripts/*.lua` | 各 Lua スクリプト本体 |
| `project.json` | メタデータ・ノード座標 |

### DSL → XML（dsl2xml）

編集後の DSL を XML に戻します。

```bash
pnpm cli dsl2xml <project.json> --out <output.xml>
```

### その他のコマンド

```bash
# DSL の構造チェック（未解決の参照など）
pnpm cli check-dsl <project.json>

# DSL の型チェック（ポートの signal 種別の整合性確認）
pnpm cli typecheck-dsl <project.json>
```

## DSL 形式

### .sw-net

ノードのインスタンス化と配線を記述します。

```
module main
  port in "Speed Input" : number
  port in "Active"      : boolean
  port out "Throttle"   : number

  inst CLAMP n1 (min=0, max=1) : value="Speed Input" -> out="Throttle"
  inst AND   n2 : a="Active", b=n1_out -> out=n2_out
end
```

- `port in / out` — モジュールの外部ポート（Stormworks の入出力ノードに対応）
- `inst <定義ID> <インスタンス名>` — ゲートを配置
- `(key=value)` — ゲートのプロパティ
- `: <入力> -> <出力>` — 配線（ポート名またはネット名で接続）

### 主な定義 ID

| カテゴリ | ID 例 |
|---|---|
| 論理 | `NOT` `AND` `OR` `XOR` `NAND` `NOR` `TOGGLE` `PULSE` |
| フリップフロップ | `SR_LATCH` `JK_FF` |
| 論理式 | `BOOL_FUNC_4` `BOOL_FUNC_8` |
| 四則演算 | `ADD` `SUBTRACT` `MULTIPLY` `DIVIDE` |
| 数値演算 | `ABS` `CLAMP` `DELTA` `MODULO` `EQUAL` |
| 関数 | `FUNC_NUM_1` `FUNC_NUM_3` `FUNC_NUM_8` |
| 比較 | `GREATER_THAN` `LESS_THAN` `THRESHOLD` |
| 制御 | `PID` `PID_ADVANCED` `TIMER_TON` `TIMER_TOF` `TIMER_RTF` `TIMER_RTO` `COUNTER` |
| 制御（その他） | `MEMORY_REGISTER` `BLINKER` `CAPACITOR` `NUM_JUNCTION` `NUM_SWITCHBOX` |
| Composite | `COMPOSITE_READ_NUMBER` `COMPOSITE_READ_BOOLEAN` `COMPOSITE_WRITE_NUMBER` `COMPOSITE_WRITE_BOOLEAN` `COMPOSITE_SWITCHBOX` `COMPOSITE_TO_NUMBER` `NUMBER_TO_COMPOSITE` |
| 映像・音声 | `VIDEO_SWITCHBOX` `AUDIO_SWITCHBOX` |
| Lua | `LUA` |
| 定数 | `CONST` `CONST_BOOL` |
| プロパティ | `PROPERTY_NUMBER` `PROPERTY_SLIDER` `PROPERTY_TOGGLE` `PROPERTY_TEXT` `PROPERTY_DROPDOWN` |
| デバッグ | `TOOLTIP_NUMBER` `TOOLTIP_BOOLEAN` |

### .sw-mcl

`LUA` ノードのスクリプトファイルを参照します。通常は自動生成されます。

### project.json

マイコン名・サイズ・各ノードの座標などのメタデータを保持します。
