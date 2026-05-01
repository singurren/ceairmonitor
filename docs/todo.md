# TODO

更新时间：`2026-05-01`

## 当前优先级

1. 为 `NAS` 部署收尾，确认服务端后台运行方式和持久化文件路径
2. 保持 `WSL` 日期级筛选 + `Windows Chrome` 插件航班级确认主链路可用
3. 只在插件路线继续受阻时，再启用 Playwright 备选方案

## 具体待办

- 让 `WSL` 服务继续只负责日期级筛选、规则匹配、航班级事件去重和通知
- 继续在 Windows Chrome 插件里定位“页面最终用于渲染的航班数组”抓取点
- 验证最新页面状态扫描逻辑是否能直接从全局状态对象里拿到航班数组
- 验证最新 DOM 兜底逻辑是否能从页面最终渲染结果中稳定抽到：
  - `flight_no`
  - `dep_time`
  - `arr_time`
- 串完整体链路：日期级命中 -> Windows 真实 Chrome 页面检查 -> 插件回传 -> 服务端按航班级触发通知
- 验证新的规则模型在真实场景配置中是否稳定，当前目标覆盖：
  - `上海 -> 深圳`，周一 `07:30 - 09:40`
  - `深圳 -> 上海`，周四 `16:00` 以后
  - `深圳 -> 上海`，周五 `12:00` 以后
- 确认正式部署口径已固定为：
  - 北京时间“今天”起
  - 包含今天在内总共 `14` 天
  - 因为代码按起止都包含计算，所以配置应为 `start_offset_days = 0`、`days_ahead = 13`
- 已确认每日去重状态重置时点为北京时间 `07:00`
- 已验证新的 WSL 常驻脚本符合当前 NAS/WSL 目标路径：
  - `/home/gurren/project/ceairmonitor`
  - `./scripts/ceair-daemon.sh start`
  - `.run/ceair-monitor.pid`
  - `.run/ceair-monitor.log`
- 已验证后台脚本优先走 `.venv/bin/ceair-monitor`，当前实际进程命令为 `.venv/bin/python .../.venv/bin/ceair-monitor`
- 已修复 `restart` 只 stop 不 start 的问题
- 已修复当前命令会话退出后后台进程被清理的问题，启动命令已改为 `nohup setsid`
- 验证当前机器上的 `install-wsl-boot.sh` / `uninstall-wsl-boot.sh` 是否能稳定写入和移除 `/etc/wsl.conf` 的 boot command
- 已验证 `.run/ceair-monitor.log` 能稳定输出轻量运行日志，已用于定位 `2026-05-01 07:00` 未推送和 `10:51` 单次 `502` 问题
- 继续观察 `502/504` 网关瞬断是否已不再产生单次误报；只有持续超过 `2` 小时才应推维护者提醒
- 上线前创建本地私有通知密钥文件：
  - `data/secrets.local.json`
  - 仅保留 `serverchan_sendkeys`
- 如果需要维护者日报：
  - 在 `data/secrets.local.json` 里增加 `maintainer_serverchan_sendkeys`
  - 确认每天 `12:00` 自检推送是否送达
- 记录并避免重复以下已验证但未跑通的插件探索：
  - `JSON.parse`
  - `TextDecoder.decode`
  - `CryptoJS.AES.decrypt`
  - `CryptoJS.enc.Utf8.stringify`
- 明确记住当前现实限制：页面存在反调试机制，DevTools 打开后刷新更容易触发验证，且在该状态下验证难以通过
- 观察新增 trace：
  - `dom_flights_not_found`
  - `dom_flights_captured`
  - `capture_send_ack`
  - `capture_send_failed`
  - `capture_send_skipped_duplicate`
  - `forward_failed`
- 观察最近回传结果和后台 trace 里的：
  - `captureSource`
  - `captureMeta`
- 验证扩展后台到本地服务 endpoint 的可达性，而不是继续怀疑抓取链
- 必要时把插件 endpoint 从 `127.0.0.1` 改成 Windows 可访问的 WSL IP
- 在真实规则配置下验证：
  - `matched_rules`
  - `new_event_count`
  - `notification`
- 测试阶段先优先验证插件“最近一次回传结果”里的：
  - `flights`
  - `flightCount`
  - `captureSource`
- 验证自动开页链路：
  - `auto_open_poll_completed`
  - `openedCount`
  - `deferredCount`
  - `followupScheduled`
  - 自动打开的 `flightList` 页面是否随后产生 `forward_completed`
- 验证自动关闭链路：
  - `auto_open_tab_created`
  - `auto_open_tab_closed`
- 验证风控超时告警链路：
  - `auto_open_timeout_cleanup`
  - `warnedCount`
  - 服务端是否收到 `/api/flight-warning`
  - 是否推送：`可能已经触发风控，请检查确认`
- 验证每小时兜底清理链路：
  - `hourly_cleanup_completed`
  - `closedCount`
  - 是否能清掉残留的 `https://ecactivity.ceair.com/` 标签页
- 验证“下一轮服务轮询仍可兑 -> 再次自动开页”是否成立
- 确认 duplicate 去重现在只在“后台已成功确认”后生效，而不是在发送前就锁死
- 验证正常业务通知正文已统一为：
  - `yyyy-mm-dd 周x ;出发地 -> 目的地`
  - 下一行：`起飞时间，航班号； 起飞时间，航班号；...`
  - 不同日期之间空一行
- 后续做人工对账测试时，先临时把 `notifications_enabled` 设为 `false`，避免同时收到正常业务通知和测试汇总通知
- 只在插件路线继续受阻时，再回头验证：
  - `uv run ceair-save-state`
  - `POST /api/browser-probe`
  - Playwright 备选链路
