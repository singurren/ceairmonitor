# 东航趣游卡监控器 Spec v0.2

## 1. 背景

用户希望监控东方航空兑换卡的可兑换放票情况，核心目标是尽快发现目标时间窗口内的可兑航班：

- 出发地：上海
- 目的地：深圳
- 去程时间：周一 `00:00 - 09:40`
- 返程时间：周四 `16:00` 以后、周五 `12:00` 以后

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

做一个“日期级筛选 + 航班级确认”的兑换卡监控器。

当前正式主链路：

1. 服务端轮询日期级可兑接口
2. 日期级命中后，由 Windows Chrome 扩展打开真实航班页
3. 扩展回传航班号、起飞时间、到达时间
4. 服务端按规则时间窗口过滤
5. 对新的命中航班发送通知

不在本期承诺：

- 自动下单 / 自动兑换
- 绕过复杂安全策略
- 航班余位数量精确监控
- 税费监控

## 5. 当前能力边界

目前服务端能稳定提供的是：

- 指定起终点、产品码、卡类型额外参数
- 指定星期或指定日期
- 日期级可兑状态轮询
- 多规则匹配
- 航班级事件去重
- 通知分组和维护者告警

航班级结果由 Windows Chrome 扩展提供：

- 扩展在真实浏览器环境中打开航班页
- 抓取页面最终渲染出来的航班列表
- 回传 `POST /api/flight-result`
- 服务端按 `start_time / end_time` 过滤

这种方案替代了早期讨论过的 Linux 无头浏览器 / Playwright 路线。原因是：

- 纯服务端 HTTP 访问 `shoppingv2` 容易命中阿里云 WAF
- 无头浏览器路线在部署和验证稳定性上成本更高
- 当前已有 Windows 真 Chrome + 扩展链路，可以复用真实浏览器态

当前仍不能承诺：

- 页面触发验证时一定能自动恢复
- 精确余位数量
- 税费金额

截至 `2026-04-15` 的最新逆向结果，这一层已经基本定位清楚：

- 航班列表页是 `https://m.ceair.com/mapp/reserve/flightList`
- 页面会把 `newParam` 还原为 `searchCondition`
- 实际拉取航班列表的接口不是日期级接口，而是：
  `POST https://m.ceair.com/m-base/sale/shoppingv2`

同时也确认了当前最大的实现风险：

- 纯服务端 HTTP 访问 `shoppingv2` 很容易命中阿里云 WAF
- 被拦截时返回的是验证页，不是业务 JSON
- 验证页中会包含 `traceid / sceneId / token`

因此当前工程路线固定为：

- 服务端不直接绕 WAF
- 服务端不依赖 Linux 无头浏览器
- Windows Chrome 扩展负责航班级补查
- 服务端负责状态、规则、去重和通知

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
- 航班级扩展回传状态

### 6.3 暂不做

- 自动兑换
- 用户系统
- App 自动化

说明：

- “暂不做”指的是“不承诺稳定可用”
- 航班级确认由真浏览器扩展承担；Linux 无头浏览器路线不再作为推荐路线

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
  "name": "去程 上海到深圳 周一上午",
  "origin_codes": ["SHA"],
  "destination_codes": ["SZX"],
  "weekdays": [1],
  "window_start_date": "2026-05-10",
  "days_ahead": 34,
  "start_time": "00:00",
  "end_time": "09:40",
  "product_code": "YRDCCN0525",
  "route_type": "OW"
}
```

说明：

- `weekdays` 使用当前代码约定，`0 = 周日`，`1 = 周一`
- `start_time / end_time` 存在时，日期级命中后还必须等待航班级回传并命中时间窗口
- 不同兑换卡可以通过 `card_name / notification_group / product_code / query_extra_params` 分组

## 8. 事件判定

日期级事件触发条件：

- 上一次状态是 `"1"`，当前状态是 `"2"`
- 上一次无该日期，当前首次出现且状态是 `"2"`

但只要规则配置了 `start_time` 或 `end_time`，日期级事件不会直接推送业务通知，而是等待扩展回传航班结果。

航班级事件触发条件：

- 日期级状态为 `"2"`
- 扩展回传的航班列表中存在命中时间窗口的航班
- 航班事件主键 `rule + route + date + flight_no + dep_time` 当天未出现过

不触发事件的情况：

- `"1" -> "1"`
- `"2" -> "2"`
- 其他无效状态重复出现
- 航班回传成功但没有命中时间窗口
- 命中航班当天已经通知过

建议事件模型：

```json
{
  "type": "flight_window_opened",
  "rule_name": "去程 上海到深圳 周一上午",
  "product_code": "YRDCCN0525",
  "origin": "SHA",
  "destination": "SZX",
  "date": "2026-05-11",
  "flight_no": "MU1234",
  "dep_time": "08:15",
  "detected_at": "2026-05-01T07:10:00+08:00"
}
```

## 9. 技术方案

### 9.1 分层

1. `connector`
   调用 `queryRedeemableDetailNew`
2. `normalizer`
   把 `redeemableDetailMap` 转为内部日期状态模型
3. `matcher`
   按多规则过滤日期、航线和时间窗口
4. `detector`
   对比前后快照，识别日期级和航班级新事件
5. `notifier`
   输出提醒
6. `chrome-extension`
   在真实 Windows Chrome 中补查航班列表并回传

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
- 页面日期级接口只到日期，不到航班
- 航班级补查依赖 Windows Chrome 扩展和页面加载状态
- 页面触发验证或加载超时时，扩展会回传风控/超时告警

## 10. 原型定义

本仓库当前原型用于配置和状态查看，不是最终运行入口。方向已经明确：

- 左侧配置规则
- 右侧展示候选日期状态
- 时间线展示轮询、扩展回传、通知和告警状态

## 11. 实施路线

当前已完成：

- 真实日期级接口轮询
- 多规则配置
- 状态持久化和每日 `07:00` 重置
- Server 酱通知
- Windows Chrome 扩展回传航班结果
- 航班级时间窗口过滤和去重
- NAS/WSL 后台常驻脚本

## 12. 当前最关键的下一步

当前最关键的下一步是生产观测和收敛：

1. 继续观察真实运行日志中的 `external_flight_result` 和 `external_warning`
2. 确认扩展在 Windows Chrome 长时间运行时能稳定自动开页、回传和关闭标签页
3. 只针对真实误报或漏报修复规则、去重和告警策略
