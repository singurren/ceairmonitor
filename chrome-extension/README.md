# Chrome Extension

最小可用 Chrome 插件骨架。

## 作用

- 监听页面里的 `shoppingv2` 请求响应
- 提取航班列表
- 回传到本机 WSL 服务：`POST http://127.0.0.1:8766/api/flight-result`
- 同时支持两种页面入口：
  - `https://m.ceair.com/mapp/reserve/flightList?newParam=...`
  - `https://ecactivity.ceair.com/qysz-coupon/exchange.html?obj=...`

## 安装

1. 打开 `chrome://extensions`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择当前目录 `chrome-extension/`

## 配置

安装后打开扩展详情页里的“扩展程序选项”，确认：

- 已启用转发
- 接口地址是 `http://127.0.0.1:8766/api/flight-result`

## 调试

- 不要把“打开 DevTools 后刷新页面”当成默认调试方式
- 当前已确认页面存在反调试机制，DevTools 打开后刷新更容易触发验证
- 更稳妥的方式是直接看扩展选项页里的：
  - “最近回传结果”
  - “最近一次调试痕迹”
- 如需看扩展侧日志，再去 `chrome://extensions` 查看 service worker 日志
- WSL 服务侧检查：
  - `GET /api/status`
  - `state.last_external_flight_result`
- 如果扩展选项页里的“最近回传结果”显示 `shoppingv2_non_json`，说明插件已经看到了航班接口，但返回的是滑块/WAF 页面，不是航班 JSON
- 如果出现 `shoppingv2_empty_flights`，说明插件看到了接口响应，但没有从返回体里直接解出航班数组
- 当前插件已经新增 DOM 兜底：即使 `shoppingv2` 是密文包装，也会继续尝试从页面最终渲染出来的航班文本里抽取结果
- 当前插件还会额外尝试扫描页面常见全局状态对象，如果页面状态层里已经持有航班数组，也会直接提取并回传
- 扩展选项页里的“最近一次调试痕迹”会显示当前走到哪一层，例如：
  - `content_bootstrap`
  - `page_hook_injected`
  - `context_parse_failed`
  - `shoppingv2_captured`
  - `shoppingv2_empty_flights`
  - `dom_flights_not_found`
  - `dom_flights_captured`
  - `capture_send_ack`
  - `capture_send_failed`
  - `capture_send_skipped_duplicate`
  - `background_received_flights`
  - `forward_completed`
- `background_received_flights` 和 `forward_completed` 里现在会额外带：
  - `captureSource`
  - `captureMeta`

这些字段用于区分本次命中到底来自：

- `shoppingv2_payload`
- `window_scan_*`
- `rendered_dom`

`capture_send_skipped_duplicate` 现在还会区分：

- `dedupeState = "acked"`：后台已经成功确认过，这次才跳过
- `dedupeState = "inflight"`：同一批航班正在发送中，短暂去重
