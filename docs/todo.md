# TODO

更新时间：`2026-05-01`

## 当前主线

当前项目主线已经固定为：

- `WSL`/NAS 服务端负责日期级筛选、规则匹配、状态持久化、去重、通知和告警
- `Windows Chrome` 扩展负责真实浏览器环境里的航班级补查
- Linux 无头浏览器 / Playwright 不再作为推荐路线

## 仍需观察

- 观察真实运行日志中的 `poll_completed`、`external_flight_result`、`external_warning`
- 继续确认 `502/504` 网关瞬断不会再产生单次误报；只有持续超过 `2` 小时才应推维护者提醒
- 观察扩展在长时间运行时是否稳定自动开页、回传航班、关闭标签页
- 重点关注 `capture_timeout` 是否持续出现在同一日期或同一路线
- 需要人工对账时，先临时把 `notifications_enabled` 设为 `false`，避免业务通知和测试通知混在一起

## 当前业务规则

- 去程：`上海 -> 深圳`，周一 `00:00 - 09:40`
- 返程：`深圳 -> 上海`，周四 `16:00` 以后
- 返程：`深圳 -> 上海`，周五 `12:00` 以后
- 行享东方：`杭州 -> 悉尼`，固定日期段，独立通知组

## 已完成但需要保留认知

- 每日去重状态重置时点是北京时间 `07:00`
- 服务自动轮询窗口是北京时间 `07:00` 到次日 `01:00`
- 后台脚本目标路径是 `/home/gurren/project/ceairmonitor`
- 后台脚本已修复：
  - 优先使用 `.venv/bin/ceair-monitor`
  - `restart` 会重新启动
  - `start` 使用 `nohup setsid` 脱离当前维护会话
- `.run/ceair-monitor.log` 是 NAS 实际部署环境的首要排查入口
- `data/secrets.local.json` 是本地私有通知密钥文件，不提交

## 后续只在出现问题时处理

- 如果 Chrome 扩展无法访问本地服务，再检查 endpoint 是否需要从 `127.0.0.1` 改成 Windows 可访问的 WSL IP
- 如果同一日期持续 `capture_timeout`，优先检查 Windows Chrome 是否运行、扩展是否加载、页面是否触发验证
- 如果业务通知疑似漏发，先对照 `state.json` 的 `previous_external_flight_keys` 和 `.run/ceair-monitor.log` 的 `new_event_count`
