# 东航趣游卡监控器 Spec v0.2

## 1. 背景

用户希望监控东方航空 `东航趣游卡 - 趣游神州 全国版` 的可兑换放票情况，核心目标是尽快发现：

- 出发地：上海
- 目的地：深圳
- 起飞时间：周日或周一

项目最初假设是“趣游卡入口只在 App 内，缺少稳定网页版入口”，因此先做了偏通用的原型设计。

截至 `2026-04-15`，这个假设已经被修正：

- 已确认存在浏览器入口：`https://ecactivity.ceair.com/qysz-coupon/exchange.html?...`
- 已确认前端页面直接调用可复用的公开查询接口
- 因此第一版监控器不需要以 App 抓包作为前置条件

## 2. 公开检索结论

截至 `2026-04-15` 的公开检索，没有发现成熟、公开、专门面向“东航趣游卡放票监控”的现成工具。

检索结果主要是：

1. 趣游卡产品介绍或攻略，而不是监控工具
2. 用户投诉或讨论“可兑换座位释放不透明”
3. 通用 App 抓包 / 自动化方案，而不是针对趣游卡的成品

参考链接：

- 趣游卡产品介绍：<https://www.yydonkey.com/friend/detail/1672>
- 黑猫投诉公开讨论：<https://tousu.sina.com.cn/complaint/view/17394429291?sld=c2ad6a764f1cf906d7d8d91bc5620243>
- 已验证兑换页：<https://ecactivity.ceair.com/qysz-coupon/exchange.html>

## 3. 已验证入口与接口

### 3.1 浏览器入口

兑换页 URL 中的 `obj` 参数是 Base64 编码 JSON。

你给出的样本解码后为：

```json
{
  "productCode": "YRDCCN0525",
  "depCode": "SZX",
  "desCityName": "深圳",
  "oriCityCode": "SHA",
  "oriCityName": "上海",
  "depDate": "2026-04-18",
  "currentDate": "2026-04-15",
  "sixDate": "2026-04-21",
  "ticketType": "economyClass",
  "mIsInter": ""
}
```

注意：

- `depCode` 这个字段名在这里并不直观，实际承载的是目的地机场代码 `SZX`
- 页面真实逻辑应以 JS 实现为准，不能只按字段名猜

### 3.2 页面前端中的真实查询接口

已从页面脚本 `exchange.89630db9.js` 确认：

`POST https://ecskgateway.ceair.com/openApi/redeemable/queryRedeemableDetailNew`

前端传参：

```json
{
  "depDate": "2026-04-18",
  "oriCityCode": "SHA",
  "desCityCode": "SZX",
  "productCode": "YRDCCN0525",
  "indexNo": "1",
  "routeType": "OW",
  "channelCode": "NzcwMQ==",
  "salesChannel": "NzcwMQ=="
}
```

### 3.3 已验证响应

实际请求已验证成功，响应示例：

```json
{
  "code": 200,
  "msg": "success",
  "success": true,
  "data": {
    "redeemableDetailMap": {
      "2026-04-18": "1",
      "2026-04-19": "1",
      "2026-04-20": "1",
      "2026-04-21": "1",
      "2026-04-22": "1",
      "2026-04-23": "1",
      "2026-04-24": "1"
    }
  }
}
```

结合页面逻辑，状态码语义已确认：

- `"2"`：可兑换，前端展示“去兑换”
- `"1"`：无可兑换座位
- 其他值：暂无直达航班

## 4. 产品目标

做一个“趣游卡日期级放票监控器”，优先解决下面这件事：

- 监控 `上海 -> 深圳`
- 针对 `趣游神州全国版 5 次卡`，即 `productCode = YRDCCN0525`
- 只关注周日和周一
- 当某天状态从 `"1"` 变成 `"2"` 时立即提醒

这已经足够满足“监控 + 提醒”的第一版目标。

不在本期承诺：

- 自动下单 / 自动兑换
- 绕过复杂安全策略
- 航班级别余位精确监控

## 5. 当前能力边界

目前已验证接口能稳定提供的是：

- 指定起终点
- 指定产品码
- 从起始日开始连续 7 天的日期级可兑状态

因此第一版可以做：

- 日期级监控
- 周日 / 周一过滤
- 状态变化检测
- 消息提醒

但当前还不能直接回答：

- 具体是哪一班 `MUxxxx` 可兑
- 具体余位数量
- 税费金额

这些需要继续定位“点击去兑换之后”的航班列表接口。

截至 `2026-04-15` 的最新逆向结果，这一层已经基本定位清楚：

- 航班列表页是 `https://m.ceair.com/mapp/reserve/flightList`
- 页面会把 `newParam` 还原为 `searchCondition`
- 实际拉取航班列表的接口不是日期级接口，而是：
  `POST https://m.ceair.com/m-base/sale/shoppingv2`

同时也确认了当前最大的实现风险：

- 纯服务端 HTTP 访问 `shoppingv2` 很容易命中阿里云 WAF
- 被拦截时返回的是验证页，不是业务 JSON
- 验证页中会包含 `traceid / sceneId / token`

当前更现实的过渡路线是：

- 不直接上完整浏览器自动化
- 先复用用户本地浏览器中已经成功发出的 `shoppingv2` 请求上下文
- 具体做法是从浏览器开发者工具导出一条 cURL，再把其中的 Cookie、UA 和关键请求头导入监控服务

在这条路线之外，当前又新增了一个更适合长期演进的浏览器侧方案：

- 保留日期级直连接口作为一级筛选
- 一旦某天日期级显示可兑，再触发 Playwright 浏览器探针
- 浏览器探针负责打开真实航班列表页并观察 `shoppingv2` 响应
- 最终通知应以航班级结果为准，而不是仅以日期级结果为准

当前代码已经补了第一版 Playwright 会话准备能力：

- 可通过 `uv run ceair-save-state` 打开浏览器
- 用户手动完成验证后，把当前上下文保存为 `storage state`
- 后续浏览器探针优先复用这份会话状态

这意味着未来部署时可以分成两步：

1. 在本机先完成一次人工验证并生成 `storage state`
2. 再把这份状态文件交给浏览器探针或服务器环境复用

这意味着“航班级监控”在逻辑上已经有方向，但在工程上暂时受制于风控。

## 6. MVP 功能范围

### 6.1 必须有

- 规则配置
- 浏览器接口轮询
- `redeemableDetailMap` 状态解析
- 新放票事件识别
- 提醒输出

### 6.2 应该有

- 多规则支持
- 多机场支持：`SHA / PVG`
- 告警去重
- 轮询间隔设置
- 历史状态快照
- 航班级接口探测状态

### 6.3 暂不做

- 自动兑换
- 用户系统
- App 自动化

说明：

- “暂不做”指的是“不承诺稳定可用”
- 代码层面可以先保留航班级探测器和 WAF 识别能力，为后续浏览器态接入做准备

## 7. 监控规则模型

建议字段：

- 规则名称
- `productCode`
- 出发机场列表
- 到达机场列表
- 星期过滤
- 起始日期偏移策略
- 轮询间隔
- 通知渠道

当前最小规则可表达为：

```json
{
  "name": "上海到深圳 周日/周一",
  "productCode": "YRDCCN0525",
  "originCodes": ["SHA", "PVG"],
  "destinationCodes": ["SZX"],
  "weekdays": [0, 1],
  "pollIntervalSeconds": 300
}
```

说明：

- 这里的 `weekdays` 建议用标准星期表示，`0 = 周日`，`1 = 周一`

## 8. 事件判定

对单个日期触发事件的条件：

- 上一次状态是 `"1"`，当前状态是 `"2"`
- 上一次无该日期，当前首次出现且状态是 `"2"`

不触发事件的情况：

- `"1" -> "1"`
- `"2" -> "2"`
- 其他无效状态重复出现

建议事件模型：

```json
{
  "type": "redeemable_opened",
  "productCode": "YRDCCN0525",
  "origin": "SHA",
  "destination": "SZX",
  "date": "2026-04-20",
  "previousStatus": "1",
  "currentStatus": "2",
  "detectedAt": "2026-04-15T21:30:00+08:00"
}
```

## 9. 技术方案

### 9.1 分层

1. `connector`
   调用 `queryRedeemableDetailNew`
2. `normalizer`
   把 `redeemableDetailMap` 转为内部日期状态模型
3. `matcher`
   过滤周日 / 周一
4. `detector`
   对比前后快照，识别新放票
5. `notifier`
   输出提醒

### 9.2 Connector 请求定义

请求地址：

`POST https://ecskgateway.ceair.com/openApi/redeemable/queryRedeemableDetailNew`

建议默认请求头：

```http
Content-Type: application/json
```

建议默认请求体：

```json
{
  "depDate": "2026-04-18",
  "oriCityCode": "SHA",
  "desCityCode": "SZX",
  "productCode": "YRDCCN0525",
  "indexNo": "1",
  "routeType": "OW",
  "channelCode": "NzcwMQ==",
  "salesChannel": "NzcwMQ=="
}
```

### 9.3 风险

- 接口未来可能增加校验
- 可能存在访问频率限制
- 页面可兑状态只到日期级，不到航班级
- `SHA` 与 `PVG` 是否都适配，需要分别验证

## 10. 原型定义

本仓库当前原型仍然是 mock 版，但方向已经明确：

- 左侧配置规则
- 右侧展示候选日期状态
- 时间线展示“某天从不可兑变为可兑”

下一步应把 mock 数据替换为真实接口返回。

## 11. 实施路线

### Phase 1

- 用真实浏览器接口替换 mock 数据
- 完成日期级监控
- 完成状态变化提醒

### Phase 2

- 继续定位“去兑换”后的航班列表接口
- 尝试升级成航班级监控
- 评估是否能拿到税费、余位等字段

### Phase 3

- 接入邮件 / 飞书 / Telegram 等通知
- 加入持久化
- 支持多规则并发

## 12. 当前最关键的下一步

现在最合理的下一步已经不是 App 抓包，而是：

1. 直接基于 `queryRedeemableDetailNew` 做一个真实可跑的日期级监控器
2. 再用浏览器开发者工具继续定位“点击去兑换”后的航班列表接口

如果后续能找到第二个接口，就把监控从“哪一天放票”升级为“哪一班放票”。
