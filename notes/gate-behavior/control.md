# 制御系（control）— タイマー・PID・カウンター・容量など

<!-- 確認環境: （プレイしているStormworksのバージョン・確認した大体の時期を1回だけ書いてください。例: v1.x系 / 2026年7月ごろ） -->

このファイルに含まれるゲートで、知っている・確認できることだけ自由な日本語で書いてください。
JSONの構文は気にしなくて大丈夫です。箇条書きでも、走り書きでも、「こう配線したらこうなった」という
体験談でも構いません。分からないゲートは見出しごと空欄のまま残してOKです（スキップ扱いになります）。

> **書く基準**: ヒント全部に答える必要はありません。「これを知らずにDSLを書いたユーザーが
> 実機で驚くか？」を基準にしてください。驚かない（DSLの使い方・変換結果に影響しない）純粋な
> エンジン内部トリビアは書かなくてOKです。

---

## MEMORY_REGISTER（Memory Register）
（関連: #4）

> ヒント（実機で驚きうる点。答えられるものだけで可。分からなければ本文は空欄のままでOK）:
> - reset系入力がある場合、reset時の内部状態（0に戻る/直前値保持など）
> - interval/charge_time等の時間パラメータの単位（秒かtickか）
> - issue #4 で明示的に指摘: set/reset同時入力時の優先順位が未確認

---

## NUM_JUNCTION（Numerical Junction）

> ヒント（実機で驚きうる点。答えられるものだけで可。分からなければ本文は空欄のままでOK）:
> - reset系入力がある場合、reset時の内部状態（0に戻る/直前値保持など）
> - interval/charge_time等の時間パラメータの単位（秒かtickか）

---

## NUM_SWITCHBOX（Numerical Switchbox）

> ヒント（実機で驚きうる点。答えられるものだけで可。分からなければ本文は空欄のままでOK）:
> - reset系入力がある場合、reset時の内部状態（0に戻る/直前値保持など）
> - interval/charge_time等の時間パラメータの単位（秒かtickか）

---

## BLINKER（Blinker）

> ヒント（実機で驚きうる点。答えられるものだけで可。分からなければ本文は空欄のままでOK）:
> - reset系入力がある場合、reset時の内部状態（0に戻る/直前値保持など）
> - interval/charge_time等の時間パラメータの単位（秒かtickか）

---

## CAPACITOR（Capacitor）
（関連: #4）

> ヒント（実機で驚きうる点。答えられるものだけで可。分からなければ本文は空欄のままでOK）:
> - reset系入力がある場合、reset時の内部状態（0に戻る/直前値保持など）
> - interval/charge_time等の時間パラメータの単位（秒かtickか）
> - issue #4 で明示的に指摘: charge_time/discharge_timeの詳細挙動、充電途中の出力値が未確認

---

## PID（PID Controller）

> ヒント（実機で驚きうる点。答えられるものだけで可。分からなければ本文は空欄のままでOK）:
> - reset系入力がある場合、reset時の内部状態（0に戻る/直前値保持など）
> - interval/charge_time等の時間パラメータの単位（秒かtickか）

---

## PID_ADVANCED（PID Controller (Advanced)）

> ヒント（実機で驚きうる点。答えられるものだけで可。分からなければ本文は空欄のままでOK）:
> - reset系入力がある場合、reset時の内部状態（0に戻る/直前値保持など）
> - interval/charge_time等の時間パラメータの単位（秒かtickか）

---

## TIMER_TON（Timer (TON)）

> ヒント（実機で驚きうる点。答えられるものだけで可。分からなければ本文は空欄のままでOK）:
> - reset系入力がある場合、reset時の内部状態（0に戻る/直前値保持など）
> - interval/charge_time等の時間パラメータの単位（秒かtickか）

---

## TIMER_TOF（Timer (TOF)）

> ヒント（実機で驚きうる点。答えられるものだけで可。分からなければ本文は空欄のままでOK）:
> - reset系入力がある場合、reset時の内部状態（0に戻る/直前値保持など）
> - interval/charge_time等の時間パラメータの単位（秒かtickか）

---

## TIMER_RTO（Timer (RTO)）

> ヒント（実機で驚きうる点。答えられるものだけで可。分からなければ本文は空欄のままでOK）:
> - reset系入力がある場合、reset時の内部状態（0に戻る/直前値保持など）
> - interval/charge_time等の時間パラメータの単位（秒かtickか）

---

## TIMER_RTF（Timer (RTF)）

> ヒント（実機で驚きうる点。答えられるものだけで可。分からなければ本文は空欄のままでOK）:
> - reset系入力がある場合、reset時の内部状態（0に戻る/直前値保持など）
> - interval/charge_time等の時間パラメータの単位（秒かtickか）

---

## COUNTER（Up/Down Counter）

> ヒント（実機で驚きうる点。答えられるものだけで可。分からなければ本文は空欄のままでOK）:
> - reset系入力がある場合、reset時の内部状態（0に戻る/直前値保持など）
> - interval/charge_time等の時間パラメータの単位（秒かtickか）

