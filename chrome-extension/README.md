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

- 在东航 H5 航班列表页打开开发者工具
- 在 `chrome://extensions` 中查看 service worker 日志
- WSL 服务侧检查：
  - `GET /api/status`
  - `state.last_external_flight_result`
- 如果扩展选项页里的“最近回传结果”显示 `shoppingv2_non_json`，说明插件已经看到了航班接口，但返回的是滑块/WAF 页面，不是航班 JSON
- 扩展选项页里的“最近一次调试痕迹”会显示当前走到哪一层，例如：
  - `content_bootstrap`
  - `page_hook_injected`
  - `context_parse_failed`
  - `shoppingv2_captured`
  - `background_received_flights`
  - `forward_completed`
