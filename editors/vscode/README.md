# Stormworks sw-net (VSCode)

`.sw-net` ファイル用のシンタックスハイライトです。TextMate 文法だけで動き、ビルドは要りません。
`.sw-mcl` は JSON なので、VSCode 標準の JSON ハイライトに任せます。

## 使い方

- 試す: VSCode でこのフォルダ（`editors/vscode`）を開き、`F5` で拡張開発ホストを起動する。
- 入れる: `npx @vscode/vsce package` で `.vsix` を作り、`code --install-extension <file>.vsix` で入れる。
  または `editors/vscode` を `~/.vscode/extensions/storm-sw-net` へコピーする。

## 色が付く対象

`import … from`、`module … end`、`port in|out … : 信号型`、`inst 型 名前`、`use [別名.]モジュール 名前`、
`key=value` の key、`->`、文字列とエスケープ、数値、`true`/`false`/`null`、`#` コメント。
ゲート型名（`ADD` など）は `definitions.json` の一覧を持たず、`inst` の直後という位置で判定します。
