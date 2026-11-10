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

### ステップ3：CLIの起動を確認する

展開したフォルダで次のコマンドを実行し、ゲートの一覧が表示されることを確認してください。

```bash
pnpm cli spec --list
```

AIと一緒に作業する場合は、ローカルファイルの編集とコマンド実行に対応したAIツールで、このフォルダを開いてください。

---

## 使い方

コマンドは、ツールを展開したフォルダで実行してください。AIに依頼する場合は、CLIを使うことと入力・出力のパスを伝えてください。

### XMLをDSLに変換する（編集の準備）

```
pnpm cli xml2dsl を使って、このXMLファイルをDSL形式に変換してください。
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
pnpm cli dsl2xml を使って、DSLファイルをXMLに変換してください。
project.json：C:\Users\あなた\Documents\mycontroller-dsl\project.json
出力：C:\Users\あなた\Documents\mycontroller-edited.xml
```

### エラーチェック

```
pnpm cli check-dsl を使って、このDSLファイルにエラーがないか確認してください。
C:\Users\あなた\Documents\mycontroller-dsl\project.json
```

### 型チェック（信号の種類が合っているか確認）

```
pnpm cli typecheck-dsl を使って、信号の型が正しく接続されているか確認してください。
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

**Q. AIがstorm-mclの使い方を知らない**

→ AIにこのフォルダの `README-ja.md` を読むよう依頼してください。コマンドを実行できないAIツールでは、提案されたコマンドを自分でコマンドプロンプトから実行してください。

**Q. 同じ回路で、設定値だけ違うサブモジュールを使いたい**  
→ モジュールにパラメータを持たせると、`use` ごとにゲートの設定値を変えられます。書き方は `README-ja.md` の「モジュールパラメータ」を参照するか、AIにそこを読むよう依頼してください。

**Q. 変換したXMLをStormworksに読み込むには？**  
→ Stormworks内のマイコン編集画面で「Load」ボタンから変換後のXMLを選択します。
