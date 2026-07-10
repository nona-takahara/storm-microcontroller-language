## Summary / 概要

### Problem & goal / 解決したい課題・ゴール

### Approach / 解決のためのアプローチ

## Related issue / 関連Issue

<!-- e.g. Closes #123 -->

## Changes / 変更内容

-

### Pitfalls (optional) / 変更内容に関する落とし穴（任意）

<!-- Explain why you arrived at this implementation, especially if the approach isn't the obvious one. / どうしてこのような実装になったのか、一見普通ではない解決策をとった場合はそれを記述する。 -->

## How to test / テスト方法

<!-- Commands run, e.g. `pnpm check`, `pnpm cli check-dsl ...` / 実行したコマンドなど -->

- [ ] `pnpm check`
- [ ] `pnpm build`
- [ ] Round-trip sample test data through `dsl2xml`/`xml2dsl` and verify / 適当なテストデータで dsl2xml、xml2dsl を実施してのチェック
- [ ] (Optional) Round-trip through Stormworks: exported microcontroller → DSL conversion → XML conversion → load in Stormworks → re-export and verify / (任意) Stormworksで出力したマイクロコントローラー→DSL変換→XML変換→Stormworks読み取り→再出力チェック

## Checklist / チェックリスト

- [ ] I have tested the change locally / ローカルで動作確認した
- [ ] Documentation updated if needed / 必要に応じてドキュメントを更新した
