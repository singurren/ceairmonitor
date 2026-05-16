# ceair

东航趣游卡放票监控服务。

当前正式运行链路是：

1. `WSL`/NAS 后台服务轮询东航日期级接口
2. 日期级命中后，服务记录待补查日期
3. `Windows Chrome` 扩展在真实浏览器环境里自动打开航班页
4. 扩展抓取航班列表并回传 `POST /api/flight-result`
5. 服务端按 `rules` 中的起飞时间窗口过滤并推送新命中航班

当前可监控：

- 指定 `product_code`
- 指定出发地 / 目的地
- 从指定日期开始的一段窗口
- 指定星期或指定日期
- 不同兑换卡和通知组
- 配置了 `start_time / end_time` 的航班级时间窗口

## 主要文件

- [main.py](/home/gurren/project/ceairmonitor/main.py)
- [chrome-extension/README.md](/home/gurren/project/ceairmonitor/chrome-extension/README.md)
- [data/config.json](/home/gurren/project/ceairmonitor/data/config.json)
- [docs/spec.md](/home/gurren/project/ceairmonitor/docs/spec.md)
- [prototype/index.html](/home/gurren/project/ceairmonitor/prototype/index.html)

## 运行

```bash
uv run ceair-monitor
```

服务运行只依赖 Python 标准库，`uv sync` 不需要安装额外运行依赖。

启动后可访问：

- `GET /api/status`
- `GET /api/config`
- `PATCH /api/config`
- `POST /api/poll`
- `POST /api/maintenance-report`
- `POST /api/test-notify`
- `POST /api/flight-result`

默认地址：

- `http://127.0.0.1:8766/api/status`

## 配置

默认配置在 [data/config.json](/home/gurren/project/ceairmonitor/data/config.json)。

关键字段：

- `start_offset_days`
  从今天起偏移几天开始查，默认 `0`
- `days_ahead`
  向后查多少天。当前正式配置为 `34`，配合包含起止日期的计算方式，等价于“包含今天在内总共查询 35 天”
- `weekdays`
  监控哪些星期，使用 `0=周日, 1=周一, ... 6=周六`
- `origin_codes`
- `destination_codes`
- `product_code`
- `poll_interval_seconds`
- `backoff_step_seconds`
- `max_poll_interval_seconds`
- `serverchan_sendkeys`
- `notifications_enabled`
- `rules`

说明：

- 服务只在每天北京时间 `07:00` 到次日 `01:00` 之间执行自动轮询；其余 `6` 小时不发起新轮询
- `poll_interval_seconds`
  基础轮询间隔，默认 `600` 秒，也就是 `10` 分钟
- `backoff_step_seconds`
  触发疑似风控后，每次增加多少秒，默认 `300`
- `max_poll_interval_seconds`
  轮询间隔最大增加到多少秒，默认 `1800`
- `rules`
  可选。正式的多规则配置；如果为空，服务仍按旧的 `origin_codes + destination_codes + weekdays` 兼容运行
- 持久化去重状态
  服务会把已推送过的日期级状态和航班级事件落到 `data/state.json`，避免重复推送；这些状态会在每天北京时间 `07:00` 之后首次轮询时自动重置，同时轮询间隔会恢复到基础值 `10` 分钟
  同时会记录维护者自检推送是否已在当天发送，避免同一天中午重复发送
  自动开页链路还会额外记录最近一次成功轮询时间；浏览器扩展只会基于最近一次成功轮询产出的可兑日期任务开页，最近一轮轮询失败时不会重放旧任务
  同一轮自动开页产生的航班级结果会先按轮询批次聚合，等本轮应补查日期都有结果或超时后再统一推送；不会每个日期单独推送
  服务端轮询产生的航班事件去重和浏览器扩展回传产生的航班事件去重现在分别独立持久化，避免两条链路互相覆盖去重状态
  对于航班补查风控，还会记录持续异常状态；同一异常首次出现时只通知维护者，并把轮询间隔按 `10/15/20/25/30` 分钟逐级抬高；如果连续 `2` 小时仍未恢复，会再次通知维护者

部署方式说明：

- 这里的服务端和浏览器扩展都是为后台自动运行设计的
- 我之前在命令行里执行 `curl`、`git`、启动服务，是为了开发和测试，不是正式运行时所必需的人工步骤
- 你部署到 `NAS` 后，服务本身可以持续后台运行；Windows 侧浏览器扩展也会按已有逻辑自动轮询、自动开页、自动回传、自动推送
- 服务进程虽然常驻，但真正执行监控的时间窗是每天北京时间 `07:00` 到次日 `01:00`
- 正式运行时，你不需要不断手动在命令行里敲代码来接收或发送消息

`rules` 示例：

```json
{
  "rules": [
    {
      "name": "上海到深圳 周一早班",
      "origin_codes": ["SHA"],
      "destination_codes": ["SZX"],
      "weekdays": [1],
      "start_time": "00:00",
      "end_time": "09:40"
    },
    {
      "name": "深圳回上海 周四下午",
      "origin_codes": ["SZX"],
      "destination_codes": ["SHA"],
      "weekdays": [4],
      "start_time": "16:00"
    },
    {
      "name": "深圳回上海 2026-05-08 下午后",
      "origin_codes": ["SZX"],
      "destination_codes": ["SHA"],
      "weekdays": [],
      "specific_dates": ["2026-05-08"],
      "start_time": "15:00"
    },
    {
      "name": "行享东方 杭州到悉尼 2026-05-25 至 2026-06-09",
      "card_name": "行享东方",
      "notification_group": "economy_coupon",
      "origin_codes": ["HGH"],
      "destination_codes": ["SYD"],
      "weekdays": [],
      "specific_dates": ["2026-05-25", "2026-05-26"],
      "product_code": "XXDFGJJJ1000",
      "query_extra_params": {
        "ticketType": "economyClass",
        "mIsInter": "1"
      }
    }
  ]
}
```

规则语义：

- `weekdays` 和 `specific_dates` 二选一或同时存在都可以；只要命中其中之一，这条规则就会参与当天匹配
- 如果只想监控某几个一次性日期，可以把 `weekdays` 设为空数组，并填写 `specific_dates`
- 每条规则可以单独配置 `window_start_date`、`start_offset_days` 和 `days_ahead`；没有配置时才使用全局窗口
- 趣游卡这类周规则可以用 `window_start_date=2026-05-10` 加 `days_ahead=34` 表示从 `2026-05-10` 开始，之后每天按当前日期向后滚动 `35` 天
- 行享东方这类固定日期段只需要填写 `specific_dates`；指定日期过期后会自然停止查询
- `notification_group` 可用于把不同卡的通知发给不同 Server 酱 key；当前 `economy_coupon` 会读取 `economy_coupon_serverchan_sendkeys`
- `query_extra_params` 会透传到日期级查询接口，国际行享东方卡需要 `ticketType=economyClass` 和 `mIsInter=1`
- 没有 `start_time / end_time` 时，沿用日期级事件
- 配了时间窗口时，只有 Chrome 扩展回传航班且命中窗口后才发通知
- 航班级事件主键现在是：`rule + route + date + flight_no + dep_time`

## HTTP 修改配置示例

把查询窗口改成“包含今天在内总共查 35 天”：

```bash
curl -X PATCH http://127.0.0.1:8766/api/config \
  -H 'Content-Type: application/json' \
  -d '{"start_offset_days": 0, "days_ahead": 34}'
```

把监控星期改成周日、周一、周五：

```bash
curl -X PATCH http://127.0.0.1:8766/api/config \
  -H 'Content-Type: application/json' \
  -d '{"weekdays": [0, 1, 5]}'
```

立即触发一次轮询：

```bash
curl -X POST http://127.0.0.1:8766/api/poll
```

立即向维护者推送一条系统自检：

```bash
curl -X POST http://127.0.0.1:8766/api/maintenance-report
```

这个接口会使用最近一次轮询状态生成“东航趣游卡系统自检”正文，并发送到 `maintainer_serverchan_sendkeys`。它不受每日 `12:00` 自动自检只发送一次的限制，也不会改写自动自检的当天发送记录。

## WSL 后台常驻

如果你在 `Windows + WSL` 环境里部署，而 `systemd`/`systemctl` 不稳定或不可用，当前仓库已经提供了一个不依赖 `systemd` 的后台脚本：

- [scripts/ceair-daemon.sh](/home/gurren/project/ceairmonitor/scripts/ceair-daemon.sh)

先给它执行权限：

```bash
chmod +x ./scripts/ceair-daemon.sh
```

常用命令：

```bash
./scripts/ceair-daemon.sh start
./scripts/ceair-daemon.sh stop
./scripts/ceair-daemon.sh restart
./scripts/ceair-daemon.sh status
./scripts/ceair-daemon.sh logs
```

如果你希望服务随当前这台 `WSL` 实例启动而启动，可以直接执行：

```bash
chmod +x ./scripts/install-wsl-boot.sh ./scripts/uninstall-wsl-boot.sh
./scripts/install-wsl-boot.sh
```

它会把下面这条 boot command 写进 `/etc/wsl.conf`：

```ini
[boot]
command = bash -lc 'cd /home/gurren/project/ceairmonitor && ./scripts/ceair-daemon.sh start'
```

写完后，需要在 Windows 侧执行一次：

```powershell
wsl.exe --shutdown
```

这样下次 `WSL` 被拉起时，就会自动执行后台启动脚本。

如果你以后不想让服务随 `WSL` 启动而启动，执行：

```bash
./scripts/uninstall-wsl-boot.sh
```

然后同样在 Windows 侧执行一次：

```powershell
wsl.exe --shutdown
```

它会：

- 优先用 `.venv/bin/ceair-monitor` 在后台启动服务；只有本地虚拟环境不存在时才回退到 `uv run ceair-monitor`
- 使用 `nohup setsid` 启动，避免服务随当前终端或维护会话退出而被清理
- 把进程号写到 `.run/ceair-monitor.pid`
- 把日志写到 `.run/ceair-monitor.log`
- 如果 PID 文件过期，但实际进程还活着，`status/start/stop` 会自动重新对齐 PID 文件
- `restart` 会先停止旧进程，再重新执行 `start`
- `.run/ceair-monitor.log` 现在会记录轻量运行日志：
  - 轮询开始 / 结束
  - 插件航班回传
  - 业务通知发送结果
  - 风控告警发送结果
  - 每日 `07:00` 状态重置
  - 每日 `12:00` 维护者自检推送

如果你想让它随 `Windows` 启动，可以在“任务计划程序”里创建一个开机或登录后任务，执行：

```powershell
wsl.exe -d <你的发行版名> --cd /home/gurren/project/ceairmonitor bash -lc './scripts/ceair-daemon.sh start'
```

例如你的目标路径是 `/home/gurren/project/ceairmonitor`，那就把上面的路径保持不变即可。

注意：

- 服务能后台常驻，不代表插件链就一定能工作
- 航班级补查仍然依赖 `Windows Chrome` 正在运行并且扩展已加载
- `install-wsl-boot.sh` 解决的是“WSL 实例被拉起后，服务自动起来”
- 如果你还希望开机后自动拉起整台 `WSL`，仍然要靠 Windows 任务计划程序去调用 `wsl.exe`

## 航班结果回传

航班级补查由 `Windows Chrome` 扩展在真实浏览器环境里完成。扩展抓到航班列表后调用：

```bash
curl -X POST http://127.0.0.1:8766/api/flight-result \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "windows-chrome",
    "date": "2026-05-08",
    "origin": "SHA",
    "destination": "SZX",
    "flights": [
      {"flight_no": "MU1234", "dep_time": "08:15", "arr_time": "10:40"},
      {"flight_no": "MU5678", "dep_time": "13:30", "arr_time": "15:55"}
    ]
  }'
```

服务会：

- 按本地 `rules` 规则匹配时间窗口
- 只对新出现的命中航班生成事件
- 复用现有 `Server酱` 通知链路

## Server酱通知

当前已经内置 `Server酱` 通知适配器。

密钥不再放在主配置 [data/config.json](/home/gurren/project/ceairmonitor/data/config.json) 里，而是单独放在本地私有文件：

- [data/secrets.local.json](/home/gurren/project/ceairmonitor/data/secrets.local.json)

仓库里提供了示例文件：

- [data/secrets.example.json](/home/gurren/project/ceairmonitor/data/secrets.example.json)

推荐写法：

```json
{
  "serverchan_sendkeys": [
    "SCTxxxxxxxxxxxxxxxx",
    "SCTyyyyyyyyyyyyyyyy"
  ],
  "economy_coupon_serverchan_sendkeys": [
    "SCTaaaaaaaaaaaaaaaa"
  ],
  "maintainer_serverchan_sendkeys": [
    "SCTzzzzzzzzzzzzzzzz"
  ]
}
```

说明：

- `serverchan_sendkeys`
  多个接收人，服务会对每个 key 分别推送
- `notifications_enabled`
  可选。默认 `true`。设为 `false` 时，服务仍会继续轮询、抓航班、记录状态，但不会实际发送 `Server酱` 通知
- 主配置里的 `serverchan_sendkeys` 仍可保留为空数组，用于表达“公共配置不含私密 key”
- 程序启动时会自动合并：
  - `data/config.json` 里的 `serverchan_sendkeys`
  - `data/secrets.local.json` 里的 `serverchan_sendkeys`
- `data/secrets.local.json` 已加入 `.gitignore`，不会被提交
- 如果最终合并后仍为空，服务仍然运行，只是不发送推送
- `economy_coupon_serverchan_sendkeys`
  仅用于行享东方卡这类独立通知组；行享东方命中不会发送给普通 `serverchan_sendkeys`
- `maintainer_serverchan_sendkeys`
  仅用于维护者通知，不参与普通放票业务通知
- 服务会在每天北京时间 `12:00` 之后首次轮询时，向 `maintainer_serverchan_sendkeys` 发送一条系统自检消息
- 如需临时补发维护者自检，可调用 `POST /api/maintenance-report`
- 航班补查风控告警、轮询触发疑似风控后的策略调整提醒、以及“持续 `2` 小时仍异常”的升级提醒，也都只发送给 `maintainer_serverchan_sendkeys`

当前航班级通知正文格式统一为：

```text
yyyy-mm-dd 周x ;出发地 -> 目的地
起飞时间1，航班号1； 起飞时间2，航班号2；...
```

多日期命中时，会先按出发地排序，再按出发日期排序，最后按起飞时间排序；同一出发地内日期之间换行，不同出发地之间空一行。

规则：

- 日期行和航班行之间换行
- 不同日期之间空一行
- 同一日期下多个航班之间使用 `；` 分隔

## 状态持久化

运行后会生成：

- `data/state.json`

它会保存：

- 上一次轮询时间
- 上一次错误
- 当前窗口内的状态快照
- 最近事件

## 当前边界

当前监控已经不是单纯“日期级提醒”，而是“日期级筛选 + 真实浏览器航班级确认”。

服务端能稳定完成：

- 日期级可兑状态轮询
- 多规则匹配
- 航班级事件去重
- 通知分组与推送
- 风控/异常告警

航班号和起飞时间依赖 `Windows Chrome` 扩展回传。只要扩展能正常打开页面并回传航班列表，服务就能告诉你：

- 哪个日期命中
- 哪个方向命中
- 哪些航班号和起飞时间命中规则窗口

当前不做：

- 自动兑换
- 余位数量精确监控
- 税费监控
- 服务端绕过东航 WAF
