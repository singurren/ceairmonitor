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

当前扩展还会默认开启“自动开页”：

- 后台会每 `10` 分钟轮询一次 `endpoint` 对应的 `/api/status`
- 如果 WSL 服务最新状态里出现可兑日期任务，扩展会自动打开对应航班列表页
- 为了降低一次打开太多页触发风控的概率，当前会分批开页：
  - 每轮最多打开 `3` 个页面
  - 会按日期从近到远依次打开
  - 两次开页之间间隔 `15` 秒
  - 如果这一轮还有剩余日期任务，扩展会在 `4` 分钟后自动补开下一批
- 打开后再由内容脚本抓取当天全部航班并回传
- 自动打开的标签页在抓到结果或看到 WAF 后会自动关闭，避免标签页越积越多
- 如果个别自动关闭没有命中，后台每小时还会额外清理一次所有 `https://ecactivity.ceair.com/` 开头的标签页
- 如果自动打开的页面在 `2` 分钟内还没有回传航班结果，扩展会自动关闭该标签页，并向服务端上报一条风控告警；服务端会推送：
  - `可能已经触发风控，请检查确认`
- 同一日期任务不是“永远只开一次”
- 扩展会按“最近一次成功轮询结果”去重：
  - 同一轮成功轮询里，同一日期任务只开一次
  - 下一轮成功轮询如果该日期仍然可兑，会再次自动开页确认航班是否有变化
  - 如果最近一轮服务轮询失败，扩展不会把上一次成功轮询留下来的旧日期任务当成新一轮任务重新打开

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
  - `flights`
- 如果后台转发接口本身访问失败，还会出现：
  - `forward_failed`
  - `networkError`
  - `endpoint`

这些字段用于区分本次命中到底来自：

- `shoppingv2_payload`
- `window_scan_*`
- `rendered_dom`

`capture_send_skipped_duplicate` 现在还会区分：

- `dedupeState = "acked"`：后台已经成功确认过，这次才跳过
- `dedupeState = "inflight"`：同一批航班正在发送中，短暂去重

如果看到 `capture_send_ack` 但其中 `response.ok = false` 且报 `TypeError: Failed to fetch`，说明：

- 页面抓取已经成功
- 内容脚本到扩展后台已经成功
- 真正失败点在扩展后台访问你配置的接口地址

这时优先检查：

- 扩展选项里的 endpoint 是否仍是 `http://127.0.0.1:8766/api/flight-result`
- 这个地址在 Windows Chrome 所在环境里是否真的能访问到 WSL 服务
- 是否需要改成 Windows 可访问的 WSL IP，例如 `http://172.x.x.x:8766/api/flight-result`

测试阶段更直接的判断标准是：

- 先看插件“最近一次回传结果”里的 `flights`
- 只要这里已经出现当天全部航班，说明插件抓取主线已经工作
- `matched_rules / new_event_count / notification` 这些是后续业务联调阶段再看的结果

如果要验证自动化链路是否工作，重点看：

- 是否出现：
  - `auto_open_poll_completed`
- 它的 `openedCount` 是否大于 `0`
- 它的 `deferredCount` 是否大于 `0`
- 它的 `followupScheduled` 是否为 `true`
- 随后是否出现：
  - `dom_flights_captured`
  - `forward_completed`
- 如果要验证兜底关页是否工作，再看：
  - `hourly_cleanup_completed`
  - 其中的 `closedCount`
- 如果要验证风控超时告警是否工作，再看：
  - `auto_open_timeout_cleanup`
  - 其中的 `warnedCount`
