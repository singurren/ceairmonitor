# ceair

东航趣游卡日期级放票监控服务。

当前版本已经接入东航网页接口，可监控：

- 指定 `product_code`
- 指定出发地 / 目的地
- 从今天开始的未来一段时间，默认 `14` 天
- 指定星期，默认 `周日 + 周一`
- 当某天状态从不可兑变为可兑时发送提醒
- 对配置了时间窗口的规则，自动确认是否出现命中窗口的起飞航班

另外已经补上“航班级接口探测”骨架：

- 仅对已可兑日期尝试拉取航班列表
- 当前默认关闭
- 如果命中阿里云 WAF，会把阻断状态写进 `last_summary.flight_level`
- 不会影响日期级监控继续运行

## 主要文件

- [main.py](/home/gurren/project/ceair/main.py)
- [chrome-extension/README.md](/home/gurren/project/ceair/chrome-extension/README.md)
- [data/config.json](/home/gurren/project/ceair/data/config.json)
- [docs/spec.md](/home/gurren/project/ceair/docs/spec.md)
- [prototype/index.html](/home/gurren/project/ceair/prototype/index.html)

## 运行

```bash
uv run ceair-monitor
```

默认 `uv sync` 只安装日期级服务所需依赖，不包含 `playwright`。

如果你后面确实要启用浏览器探针，再安装可选浏览器依赖：

```bash
uv sync --extra browser
```

启动后可访问：

- `GET /api/status`
- `GET /api/config`
- `PATCH /api/config`
- `POST /api/poll`
- `POST /api/browser-probe`
- `POST /api/flight-result`

默认地址：

- `http://127.0.0.1:8766/api/status`

## 配置

默认配置在 [data/config.json](/home/gurren/project/ceair/data/config.json)。

关键字段：

- `start_offset_days`
  从今天起偏移几天开始查，默认 `0`
- `days_ahead`
  向后查多少天。当前正式配置为 `13`，配合包含起止日期的计算方式，等价于“包含今天在内总共查询 14 天”
- `weekdays`
  监控哪些星期，使用 `0=周日, 1=周一, ... 6=周六`
- `origin_codes`
- `destination_codes`
- `product_code`
- `poll_interval_seconds`
- `backoff_step_seconds`
- `max_poll_interval_seconds`
- `serverchan_sendkey`
- `serverchan_sendkeys`
- `notifications_enabled`
- `flight_level_enabled`
- `browser_user_agent`
- `m_site_cookie`
- `m_site_extra_headers`
- `playwright_headless`
- `playwright_storage_state_path`
- `playwright_timeout_ms`
- `playwright_user_data_dir`
- `playwright_browser_channel`
- `playwright_locale`
- `playwright_timezone_id`
- `playwright_viewport_width`
- `playwright_viewport_height`
- `playwright_is_mobile`
- `playwright_has_touch`
- `playwright_device_scale_factor`
- `rules`

说明：

- `poll_interval_seconds`
  基础轮询间隔，默认 `300` 秒，也就是 `5` 分钟
- `backoff_step_seconds`
  触发疑似风控后，每次增加多少秒，默认 `300`
- `max_poll_interval_seconds`
  轮询间隔最大增加到多少秒，默认 `1800`
- `flight_level_enabled`
  是否尝试拉取航班级列表，默认 `false`
  开启后会先尝试直连 `shoppingv2`，若命中 WAF 或直连失败，会自动回退到 Playwright 浏览器态探测
- `browser_user_agent`
  请求东航 `m.ceair.com` 航班列表接口时使用的浏览器 UA
- `m_site_cookie`
  可选。浏览器态的 `Cookie` 字符串；如果后续要绕过纯服务端请求被 WAF 拦截，通常需要它
- `m_site_extra_headers`
  可选。浏览器网络请求里复制出来的额外请求头，例如 `sec-ch-ua`、`priority`、`referer`
- `playwright_headless`
  Playwright 是否使用无头浏览器，默认 `true`
- `playwright_storage_state_path`
  Playwright 会话状态文件路径。仅作为降级兼容；长期运行更建议使用持久化用户目录
- `playwright_timeout_ms`
  浏览器探针默认超时，默认 `45000`
- `playwright_user_data_dir`
  Playwright 持久化浏览器目录。面向 VPS 长期运行时，优先复用这套 profile，而不是每次新建临时上下文
- `playwright_browser_channel`
  可选。系统已安装 Chrome/Chromium 时可指定 channel，例如 `chrome`；留空则使用 Playwright 自带 Chromium
- `playwright_locale`
- `playwright_timezone_id`
- `playwright_viewport_width`
- `playwright_viewport_height`
- `playwright_is_mobile`
- `playwright_has_touch`
- `playwright_device_scale_factor`
  这组参数用于让浏览器上下文更接近移动端 H5 场景，减少与真人设备的环境差异
- `rules`
  可选。正式的多规则配置；如果为空，服务仍按旧的 `origin_codes + destination_codes + weekdays` 兼容运行
- 持久化去重状态
  服务会把已推送过的日期级状态和航班级事件落到 `data/state.json`，避免重复推送；这些状态会在每天北京时间 `07:30` 之后首次轮询时自动重置

部署方式说明：

- 这里的服务端和浏览器扩展都是为后台自动运行设计的
- 我之前在命令行里执行 `curl`、`git`、启动服务，是为了开发和测试，不是正式运行时所必需的人工步骤
- 你部署到 `NAS` 后，服务本身可以持续后台运行；Windows 侧浏览器扩展也会按已有逻辑自动轮询、自动开页、自动回传、自动推送
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
      "start_time": "07:30",
      "end_time": "09:40"
    },
    {
      "name": "深圳回上海 周四下午",
      "origin_codes": ["SZX"],
      "destination_codes": ["SHA"],
      "weekdays": [4],
      "start_time": "16:00"
    }
  ]
}
```

规则语义：

- 没有 `start_time / end_time` 时，沿用日期级事件
- 配了时间窗口时，只有航班级探测拿到命中航班后才发通知
- 航班级事件主键现在是：`rule + route + date + flight_no + dep_time`

## HTTP 修改配置示例

把查询窗口改成“包含今天在内总共查 14 天”：

```bash
curl -X PATCH http://127.0.0.1:8766/api/config \
  -H 'Content-Type: application/json' \
  -d '{"start_offset_days": 0, "days_ahead": 13}'
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

从 Chrome DevTools 导入一条成功的 `shoppingv2` cURL，请求头和 Cookie 会自动写入配置：

```bash
curl -X POST http://127.0.0.1:8766/api/import-flight-curl \
  -H 'Content-Type: application/json' \
  -d '{"curl":"curl '\''https://m.ceair.com/m-base/sale/shoppingv2'\'' -H '\''cookie: ...'\'' -H '\''user-agent: ...'\'' --data-raw '\''{...}'\''"}'
```

触发一次 Playwright 浏览器探针：

```bash
curl -X POST http://127.0.0.1:8766/api/browser-probe \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-05-08","origin":"SHA","destination":"SZX"}'
```

这个接口当前用于验证：

- 无头浏览器能否打开东航航班列表页
- 页面是否立刻进入验证码 / WAF 状态
- 浏览器上下文里是否能观察到 `shoppingv2` 响应

常规轮询里，如果某条规则配置了 `start_time` 或 `end_time`，服务也会自动复用同一套 Playwright 探测逻辑做二级确认。

如果后续改成由 Windows Chrome 插件或本地 agent 回传航班列表，可调用：

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

浏览器探针的会话优先级现在是：

1. `playwright_user_data_dir` 中已有持久化 profile 时，优先复用它
2. 否则如果 `playwright_storage_state_path` 存在，则使用 storage state
3. 否则新建一次性浏览器上下文

对未来 VPS 部署，更推荐：

- 固定 `playwright_user_data_dir`
- 尽量使用系统 Chrome channel，而不是每次都用 Playwright bundled Chromium
- 保持 `locale / timezone / viewport / touch` 与目标使用环境一致

## Playwright 会话准备

当前推荐先在本机浏览器态跑通，再考虑 VPS。

项目里现在已经提供了一个会话保存脚本：

```bash
uv run ceair-save-state --target-url https://m.ceair.com/
```

如果你刚改完依赖或脚本入口，还没同步环境，先执行一次：

```bash
uv sync
```

如果你需要运行 `ceair-save-state` 或 `POST /api/browser-probe`，要改成：

```bash
uv sync --extra browser
```

如果不想依赖 script 入口，也可以直接用模块方式：

```bash
uv run python -m ceair.browser --target-url https://m.ceair.com/
```

默认会：

- 打开一个带持久化 profile 的 Playwright 浏览器
- 进入你指定的页面
- 等你手动完成验证或登录
- 终端回车后保存到 `data/playwright-storage-state.json`

可选参数：

- `--output`
- `--user-agent`
- `--headless`
- `--timeout-ms`
- `--target-url`
- `--user-data-dir`
- `--browser-channel`
- `--locale`
- `--timezone-id`
- `--viewport-width`
- `--viewport-height`
- `--no-mobile`
- `--no-touch`
- `--device-scale-factor`

注意：

- 如果你的环境没有桌面能力，不要用 `--headless` 去做这一步，因为手动验证通常需要可见浏览器
- 更现实的做法是在本机先生成 `storage state`，再复制到服务器使用

## Server酱通知

当前已经内置 `Server酱` 通知适配器。

你可以配置单个或多个 `SendKey`。

兼容旧配置：

```json
{
  "serverchan_sendkey": "SCTxxxxxxxxxxxxxxxx"
}
```

推荐的新配置方式：

```json
{
  "serverchan_sendkeys": [
    "SCTxxxxxxxxxxxxxxxx",
    "SCTyyyyyyyyyyyyyyyy"
  ]
}
```

说明：

- `serverchan_sendkey`
  单个接收人，保留兼容
- `serverchan_sendkeys`
  多个接收人，服务会对每个 key 分别推送
- `notifications_enabled`
  可选。默认 `true`。设为 `false` 时，服务仍会继续轮询、抓航班、记录状态，但不会实际发送 `Server酱` 通知
- 如果两者都配置了，会自动去重合并
- 如果都为空，服务仍然运行，只是不发送推送

当前航班级通知正文格式统一为：

```text
yyyy-mm-dd 周x ;出发地 -> 目的地
起飞时间1，航班号1； 起飞时间2，航班号2；...
```

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

现在的监控是“日期级”，不是“具体航班级”。

也就是说它能告诉你：

- `2026-04-26` 可兑了

但还不能告诉你：

- 具体是哪一班 `MUxxxx`
- 余位多少
- 税费多少

已经验证到的最新事实是：

- 航班列表页真实调用的是 `https://m.ceair.com/m-base/sale/shoppingv2`
- 纯 HTTP 轮询容易命中阿里云 WAF 验证页
- 所以当前版本只能把航班级探测做成“可选尝试 + WAF 识别 + 状态落盘”
- 当前新增了一个过渡方案：可把浏览器里成功请求 `shoppingv2` 的 cURL 导入服务，复用其中的 Cookie、UA 和关键请求头
- 真正稳定拿到航班号/起飞时间，大概率仍需要浏览器态上下文，后续再视情况升级到自动化浏览器
- 当前已经加入了一个 Playwright 浏览器探针骨架，用于验证“日期级触发后，再用浏览器态做航班级确认”这条路线
