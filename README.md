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

# .sw-mcl レイアウトを自動生成・検証する
pnpm cli layout-dsl <project.json> [--all-submodules] [--force] [--dry-run] [--grid-size <n>]

# ゲート仕様・本ツールの挙動を引く（引数無しだとツール規約とStormworks全体仕様の概要）
pnpm cli spec
pnpm cli spec --list                 # 全ゲートID一覧
pnpm cli spec SR_LATCH                # 指定ゲートの入出力・プロパティ・既知の挙動メモ
pnpm cli spec SR_LATCH --json         # 機械可読なJSON出力
```

`spec` は、ソースコードを読まなくても人間・AIエージェント双方がゲートやツールの挙動を把握できるようにするためのコマンドです（Issue #5）。ポート・プロパティの構造情報に加え、`src/node-behavior-notes.json` / `src/stormworks-system-notes.json` に記録された実機での既知の挙動（未確認の情報も確信度付きで隠さず表示）を返します。

## DSL 形式

### .sw-net

ノードのインスタンス化と配線を記述します。

```
# ファイル先頭に import を書くことで別の .sw-net を参照できる
import pid from "./pid.sw-net"

module main
  port in "Speed Input" : number
  port in "Active"      : boolean
  port out "Throttle"   : number

  # inst でゲートを配置し、: 入力 -> 出力 の形式で配線する
  inst CLAMP n1 (min=0, max=1) : value="Speed Input" -> out="Throttle"
  inst AND   n2 : a="Active", b=n1_out -> out=n2_out

  # use で別モジュールをサブモジュールとして埋め込む
  use pid.controller ctrl : input=n1_out -> output="Throttle"
end
```

**基本構文:**

- `port in / out` — モジュールの外部ポート（Stormworks の入出力ノードに対応）
- `inst <定義ID> <インスタンス名>` — ゲートを配置
- `(key=value)` — ゲートのプロパティ
- `: <入力> -> <出力>` — 配線（ポート名またはネット名で接続）
- `# ...` — 行コメント（行頭・行末どちらでも使用可）

**サブモジュール:**

別の `.sw-net` ファイルに定義したモジュールを `use` で埋め込めます。

```
# ファイル先頭で import（エイリアス from "パス" の形式）
import lib from "./lib.sw-net"

module main
  # use <エイリアス>.<モジュールID> <インスタンス名> : 入力 -> 出力
  use lib.myModule sub1 : input=someNet -> output=resultNet
end
```

同一ファイル内のモジュールはエイリアスなしで参照できます。

```
module helper
  port in "x" : number
  port out "y" : number
  inst ADD a : a="x", b="x" -> out="y"
end

module main
  port out "result" : number
  use helper h : x=someValue -> y="result"
end
```

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
