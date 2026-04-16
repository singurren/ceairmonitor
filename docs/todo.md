# TODO

更新时间：`2026-04-17`

## 当前优先级

1. 继续推进 `WSL` 日期级筛选 + `Windows Chrome` 插件航班级确认主链路
2. 把“多规则 + 时间窗口 + 航班粒度事件”模型推进到真实航班确认链路
3. 只在插件路线继续受阻时，再启用 Playwright 备选方案

## 具体待办

- 让 `WSL` 服务继续只负责日期级筛选、规则匹配、航班级事件去重和通知
- 继续在 Windows Chrome 插件里定位“页面最终用于渲染的航班数组”抓取点
- 验证最新 DOM 兜底逻辑是否能从页面最终渲染结果中稳定抽到：
  - `flight_no`
  - `dep_time`
  - `arr_time`
- 串完整体链路：日期级命中 -> Windows 真实 Chrome 页面检查 -> 插件回传 -> 服务端按航班级触发通知
- 验证新的规则模型在真实场景配置中是否稳定，覆盖：
  - `上海 -> 深圳`，周一 `07:30 - 09:30`
  - `深圳 -> 上海`，周四 `16:00` 以后
  - `深圳 -> 上海`，周五 `12:00` 以后
- 记录并避免重复以下已验证但未跑通的插件探索：
  - `JSON.parse`
  - `TextDecoder.decode`
  - `CryptoJS.AES.decrypt`
  - `CryptoJS.enc.Utf8.stringify`
- 明确记住当前现实限制：页面存在反调试机制，DevTools 打开后刷新更容易触发验证，且在该状态下验证难以通过
- 观察新增 trace：
  - `dom_flights_not_found`
  - `dom_flights_captured`
- 只在插件路线继续受阻时，再回头验证：
  - `uv run ceair-save-state`
  - `POST /api/browser-probe`
  - Playwright 备选链路
