# storm-mcl セットアップ・使い方ガイド

StormworksのマイコンXMLファイルをAIと一緒に編集するためのツールです。

---

## このツールでできること

- Stormworksのマイコンセーブデータ（XMLファイル）を、人間とAIが読み書きしやすい形式（DSL）に変換する
- DSL形式で編集したファイルを、Stormworksに読み込める形式に戻す
- ファイルにエラーや型の不整合がないかチェックする

---

## 必要なもの

### 1. Node.js（バージョン20以上）

Node.jsがインストールされているか確認してください。

**Windowsのコマンドプロンプト（またはPowerShell）で以下を実行：**

```
node --version
```

`v20.0.0` のようなバージョン番号が表示されればOKです。  
何も表示されない場合は、[Node.js公式サイト](https://nodejs.org/)からインストールしてください（「LTS」と書かれた方を選ぶ）。

### 2. pnpm

pnpmというパッケージ管理ツールが必要です。Node.jsインストール後に以下を実行してください：

```
npm install -g pnpm
```

---

## セットアップ手順

### ステップ1：ファイルを展開する

受け取ったzipファイルを任意のフォルダに展開します。  
例：`C:\Tools\storm-mcl\`

### ステップ2：依存関係をインストールする

展開したフォルダをエクスプローラーで開き、アドレスバーに `cmd` と入力してEnterキーを押します（コマンドプロンプトが開きます）。

次のコマンドを実行します：

```
pnpm install
pnpm build
```

完了すると `dist` というフォルダが作成されます。

### ステップ3：AIツールにMCPサーバーを登録する

AIツール（Claude Code、Cursor、Windsurfなど）の設定ファイルに以下を追加します。

**Claude Code（CLIまたはIDE拡張）の場合：**

`%USERPROFILE%\.claude\settings.json`（Windowsの場合）を開き、以下を追加します：

```json
{
  "mcpServers": {
    "storm-mcl": {
      "command": "node",
      "args": ["C:\\Tools\\storm-mcl\\dist\\mcp\\server.js"]
    }
  }
}
```

> `C:\\Tools\\storm-mcl\\` の部分は、実際にツールを展開したフォルダのパスに変えてください。  
> パスの区切り文字は `\\`（バックスラッシュ2つ）にする必要があります。

**Claude Desktop（デスクトップアプリ）の場合：**

`%APPDATA%\Claude\claude_desktop_config.json` を開き、同じ内容を追加します。

**Cursorの場合：**

`設定 → MCP → + Add Server` から同様の設定を追加できます。

---

## 使い方

登録が完了したら、AIに話しかけるだけで使えます。

### XMLをDSLに変換する（編集の準備）

```
このXMLファイルをDSL形式に変換してください。
入力：C:\Users\あなた\Documents\mycontroller.xml
出力先：C:\Users\あなた\Documents\mycontroller-dsl\
```

変換後、出力先フォルダに以下のファイルが生成されます：
- `project.json` — レイアウト情報
- `main.sw-net` — ノードの接続グラフ
- `main.sw-mcl` — レイアウト情報（配置座標）
- `scripts/*.lua` — Luaスクリプト本体（`main.sw-net` の `script_ref` から参照される）

### DSLをXMLに戻す（Stormworksへの読み込み準備）

```
DSLファイルをXMLに変換してください。
project.json：C:\Users\あなた\Documents\mycontroller-dsl\project.json
出力：C:\Users\あなた\Documents\mycontroller-edited.xml
```

### エラーチェック

```
このDSLファイルにエラーがないか確認してください。
C:\Users\あなた\Documents\mycontroller-dsl\project.json
```

### 型チェック（信号の種類が合っているか確認）

```
信号の型が正しく接続されているか確認してください。
C:\Users\あなた\Documents\mycontroller-dsl\project.json
```

---

## よくある質問

**Q. 「node が見つかりません」と表示される**  
→ Node.jsがインストールされていません。[Node.js公式サイト](https://nodejs.org/)からインストールしてください。

**Q. 「pnpm が見つかりません」と表示される**  
→ `npm install -g pnpm` を実行してください。

**Q. ビルド後にdistフォルダが見当たらない**  
→ `pnpm build` の出力にエラーメッセージが出ていないか確認してください。

**Q. AIがstorm-mclツールを認識しない**  
→ AIツールを再起動してください。設定ファイルの変更はツール再起動後に反映されます。パスに日本語や空白が含まれる場合は、ツールを `C:\storm-mcl\` のような英数字のみのパスに移動してみてください。

**Q. 変換したXMLをStormworksに読み込むには？**  
→ Stormworks内のマイコン編集画面で「Load」ボタンから変換後のXMLを選択します。
