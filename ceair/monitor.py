from __future__ import annotations

import datetime as dt
import http.server
import json
import re
import shlex
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


PACKAGE_ROOT = Path(__file__).resolve().parent
ROOT = PACKAGE_ROOT.parent
DATA_DIR = ROOT / "data"
CONFIG_PATH = DATA_DIR / "config.json"
STATE_PATH = DATA_DIR / "state.json"
HOST = "127.0.0.1"
PORT = 8766
CEAIR_ENDPOINT = "https://ecskgateway.ceair.com/openApi/redeemable/queryRedeemableDetailNew"
M_SITE_SHOPPING_ENDPOINT = "https://m.ceair.com/m-base/sale/shoppingv2"
SERVERCHAN_ENDPOINT = "https://sctapi.ftqq.com/{sendkey}.send"
CHANNEL_CODE = "NzcwMQ=="
DEFAULT_BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/135.0.0.0 Safari/537.36"
)
CITY_LABELS = {
    "SHA": "上海",
    "PVG": "上海",
    "SZX": "深圳",
}


def now_local() -> dt.datetime:
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=8)))


def date_range(start: dt.date, end: dt.date) -> list[dt.date]:
    days = []
    current = start
    while current <= end:
        days.append(current)
        current += dt.timedelta(days=1)
    return days


def weekday_label(date_text: str) -> str:
    labels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
    weekday = dt.date.fromisoformat(date_text).weekday()
    return labels[(weekday + 1) % 7]


def city_label(code: str) -> str:
    return CITY_LABELS.get(code.upper(), code.upper())


def normalize_sendkeys(config: "AppConfig") -> list[str]:
    keys: list[str] = []
    if config.serverchan_sendkey.strip():
        keys.append(config.serverchan_sendkey.strip())
    for key in config.serverchan_sendkeys:
        cleaned = key.strip()
        if cleaned and cleaned not in keys:
            keys.append(cleaned)
    return keys


@dataclass
class MonitorRule:
    name: str
    origin_codes: list[str]
    destination_codes: list[str]
    weekdays: list[int]
    start_time: str = ""
    end_time: str = ""
    product_code: str = ""
    route_type: str = ""
    index_no: str = ""
    channel_code: str = ""
    sales_channel: str = ""
    enabled: bool = True

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MonitorRule":
        return cls(
            name=str(data.get("name") or "").strip(),
            origin_codes=[str(item).strip().upper() for item in data.get("origin_codes", []) if str(item).strip()],
            destination_codes=[
                str(item).strip().upper() for item in data.get("destination_codes", []) if str(item).strip()
            ],
            weekdays=[int(item) for item in data.get("weekdays", [])],
            start_time=str(data.get("start_time") or "").strip(),
            end_time=str(data.get("end_time") or "").strip(),
            product_code=str(data.get("product_code") or "").strip(),
            route_type=str(data.get("route_type") or "").strip(),
            index_no=str(data.get("index_no") or "").strip(),
            channel_code=str(data.get("channel_code") or "").strip(),
            sales_channel=str(data.get("sales_channel") or "").strip(),
            enabled=bool(data.get("enabled", True)),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def has_time_window(self) -> bool:
        return bool(self.start_time or self.end_time)


def parse_clock_time(value: str) -> dt.time:
    text = value.strip()
    if not re.fullmatch(r"\d{2}:\d{2}", text):
        raise ValueError(f"invalid time value: {value}")
    hour, minute = text.split(":", 1)
    return dt.time(hour=int(hour), minute=int(minute))


def normalize_weekdays(weekdays: list[int]) -> list[int]:
    normalized: list[int] = []
    for weekday in weekdays:
        value = int(weekday)
        if value < 0 or value > 6:
            raise ValueError(f"invalid weekday value: {weekday}")
        if value not in normalized:
            normalized.append(value)
    return normalized


def validate_rule(rule: MonitorRule) -> None:
    if not rule.name:
        raise ValueError("rule name is required")
    if not rule.origin_codes:
        raise ValueError(f"rule {rule.name} missing origin_codes")
    if not rule.destination_codes:
        raise ValueError(f"rule {rule.name} missing destination_codes")
    rule.weekdays = normalize_weekdays(rule.weekdays)
    if rule.start_time:
        parse_clock_time(rule.start_time)
    if rule.end_time:
        parse_clock_time(rule.end_time)


def effective_rules(config: "AppConfig") -> list[MonitorRule]:
    if config.rules:
        rules = [MonitorRule.from_dict(item) for item in config.rules]
    else:
        rules = [
            MonitorRule(
                name="默认规则",
                origin_codes=[item.upper() for item in config.origin_codes],
                destination_codes=[item.upper() for item in config.destination_codes],
                weekdays=list(config.weekdays),
                product_code=config.product_code,
                route_type=config.route_type,
                index_no=config.index_no,
                channel_code=config.channel_code,
                sales_channel=config.sales_channel,
            )
        ]

    normalized_rules: list[MonitorRule] = []
    for index, rule in enumerate(rules, start=1):
        if not rule.name:
            rule.name = f"规则 {index}"
        if not rule.product_code:
            rule.product_code = config.product_code
        if not rule.route_type:
            rule.route_type = config.route_type
        if not rule.index_no:
            rule.index_no = config.index_no
        if not rule.channel_code:
            rule.channel_code = config.channel_code
        if not rule.sales_channel:
            rule.sales_channel = config.sales_channel
        validate_rule(rule)
        if rule.enabled:
            normalized_rules.append(rule)
    return normalized_rules


def weekday_matches(date_text: str, weekdays: list[int]) -> bool:
    weekday = dt.date.fromisoformat(date_text).weekday()
    weekday = (weekday + 1) % 7
    return weekday in weekdays


def time_window_label(start_time: str, end_time: str) -> str:
    if start_time and end_time:
        return f"{start_time}-{end_time}"
    if start_time:
        return f"{start_time} 以后"
    if end_time:
        return f"{end_time} 之前"
    return "全天"


def time_matches(dep_time: str, start_time: str, end_time: str) -> bool:
    if not start_time and not end_time:
        return True

    normalized_dep_time = dep_time.strip()
    if re.fullmatch(r"\d{4}", normalized_dep_time):
        normalized_dep_time = f"{normalized_dep_time[:2]}:{normalized_dep_time[2:]}"
    dep_clock = parse_clock_time(normalized_dep_time)

    if start_time and dep_clock < parse_clock_time(start_time):
        return False
    if end_time and dep_clock > parse_clock_time(end_time):
        return False
    return True


def flight_event_key(rule_name: str, origin: str, destination: str, date_text: str, flight_no: str, dep_time: str) -> str:
    return f"{rule_name}:{origin}-{destination}:{date_text}:{flight_no}:{dep_time}"


@dataclass
class AppConfig:
    host: str = HOST
    port: int = PORT
    poll_interval_seconds: int = 300
    backoff_step_seconds: int = 300
    max_poll_interval_seconds: int = 1800
    start_offset_days: int = 0
    days_ahead: int = 14
    weekdays: list[int] = field(default_factory=lambda: [0, 1])
    origin_codes: list[str] = field(default_factory=lambda: ["SHA"])
    destination_codes: list[str] = field(default_factory=lambda: ["SZX"])
    product_code: str = "YRDCCN0525"
    route_type: str = "OW"
    index_no: str = "1"
    channel_code: str = CHANNEL_CODE
    sales_channel: str = CHANNEL_CODE
    serverchan_sendkey: str = ""
    serverchan_sendkeys: list[str] = field(default_factory=list)
    request_timeout_seconds: int = 20
    flight_level_enabled: bool = False
    browser_user_agent: str = DEFAULT_BROWSER_USER_AGENT
    m_site_cookie: str = ""
    m_site_extra_headers: dict[str, str] = field(default_factory=dict)
    playwright_headless: bool = True
    playwright_storage_state_path: str = "data/playwright-storage-state.json"
    playwright_timeout_ms: int = 45000
    playwright_user_data_dir: str = "data/playwright-user-data"
    playwright_browser_channel: str = ""
    playwright_locale: str = "zh-CN"
    playwright_timezone_id: str = "Asia/Shanghai"
    playwright_viewport_width: int = 390
    playwright_viewport_height: int = 844
    playwright_is_mobile: bool = True
    playwright_has_touch: bool = True
    playwright_device_scale_factor: float = 3.0
    rules: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> "AppConfig":
        if not path.exists():
            config = cls()
            config.save(path)
            return config
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(**data)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=2), encoding="utf-8")


@dataclass
class AppState:
    previous_statuses: dict[str, str] = field(default_factory=dict)
    previous_flight_keys: list[str] = field(default_factory=list)
    last_poll_at: str | None = None
    last_error: str | None = None
    effective_poll_interval_seconds: int | None = None
    last_daily_reset_date: str | None = None
    last_summary: dict[str, Any] = field(default_factory=dict)
    last_external_flight_result: dict[str, Any] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> "AppState":
        if not path.exists():
            state = cls()
            state.save(path)
            return state
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(**data)

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=2), encoding="utf-8")


class WafBlockedError(RuntimeError):
    def __init__(self, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.details = details or {}


class ServerChanNotifier:
    def __init__(self, sendkeys: list[str], timeout_seconds: int) -> None:
        self.sendkeys = [sendkey.strip() for sendkey in sendkeys if sendkey.strip()]
        self.timeout_seconds = timeout_seconds

    def send(self, title: str, body: str) -> dict[str, Any]:
        if not self.sendkeys:
            return {"sent": False, "reason": "missing_sendkey"}

        results = []
        success_count = 0
        for sendkey in self.sendkeys:
            payload = urllib.parse.urlencode({"title": title, "desp": body}).encode()
            request = urllib.request.Request(
                SERVERCHAN_ENDPOINT.format(sendkey=sendkey),
                data=payload,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                    content = json.loads(response.read().decode())
                results.append({"sendkey": sendkey, "sent": True, "response": content})
                success_count += 1
            except Exception as exc:  # noqa: BLE001
                results.append({"sendkey": sendkey, "sent": False, "error": str(exc)})

        return {
            "sent": success_count > 0,
            "success_count": success_count,
            "total_count": len(self.sendkeys),
            "results": results,
        }


class CeairClient:
    def __init__(self, config: AppConfig) -> None:
        self.config = config

    def query_redeemable_dates(
        self,
        dep_date: dt.date,
        origin_code: str,
        destination_code: str,
        product_code: str,
        route_type: str,
        index_no: str,
        channel_code: str,
        sales_channel: str,
    ) -> dict[str, str]:
        payload = {
            "depDate": dep_date.isoformat(),
            "oriCityCode": origin_code,
            "desCityCode": destination_code,
            "productCode": product_code,
            "indexNo": index_no,
            "routeType": route_type,
            "channelCode": channel_code,
            "salesChannel": sales_channel,
        }
        request = urllib.request.Request(
            CEAIR_ENDPOINT,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.config.request_timeout_seconds) as response:
            data = json.loads(response.read().decode())
        if data.get("code") != 200:
            raise RuntimeError(f"unexpected ceair response code: {data.get('code')}")
        return data["data"]["redeemableDetailMap"]

    def query_flights(
        self,
        dep_date: dt.date,
        origin_code: str,
        destination_code: str,
        product_code: str,
        route_type: str,
        sales_channel: str,
    ) -> dict[str, Any]:
        payload = {
            "currentQueryType": "FLIGHT_LIST",
            "currentSegIndex": 0,
            "language": "zh",
            "selectedRoutes": [],
            "productType": "POINT",
            "routes": [
                {
                    "arrCode": destination_code,
                    "arrCodeType": "1",
                    "depCode": origin_code,
                    "depCodeType": "1",
                    "flightDate": dep_date.strftime("%Y%m%d"),
                    "segIndex": 0,
                    "depCityName": origin_code,
                    "arrCityName": destination_code,
                    "productCode": product_code,
                }
            ],
            "tripType": route_type,
            "salesChannel": sales_channel,
            "moduleX": "mShopping",
            "os": "M",
            "appVersion": "99.0.0",
            "transactionId": now_local().strftime("05%Y%m%d%H%M%S%f"),
        }
        request = urllib.request.Request(
            M_SITE_SHOPPING_ENDPOINT,
            data=json.dumps(payload).encode(),
            headers=self._m_site_headers(dep_date, origin_code, destination_code, product_code, sales_channel),
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.config.request_timeout_seconds) as response:
            raw = response.read().decode()
        self._raise_if_waf_blocked(raw)
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError("unexpected non-json flight-level response") from exc
        return data

    def _m_site_headers(
        self,
        dep_date: dt.date,
        origin_code: str,
        destination_code: str,
        product_code: str,
        sales_channel: str,
    ) -> dict[str, str]:
        referer_payload = {
            "tripType": 0,
            "depCode": origin_code,
            "arrCode": destination_code,
            "dt": "1",
            "at": "1",
            "depN": origin_code,
            "arrN": destination_code,
            "flightDate": dep_date.strftime("%Y%m%d"),
            "productType": "POINT",
            "curIndex": 0,
            "productCode": product_code,
        }
        referer = "https://m.ceair.com/mapp/reserve/flightList?newParam=" + urllib.parse.quote(
            json.dumps(referer_payload, ensure_ascii=False, separators=(",", ":"))
        )
        headers = {
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Content-Type": "application/json;charset=UTF-8",
            "Origin": "https://m.ceair.com",
            "Referer": referer,
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "User-Agent": self.config.browser_user_agent,
            "X-Requested-With": "XMLHttpRequest",
            "salesChannel": sales_channel,
        }
        if self.config.m_site_cookie.strip():
            headers["Cookie"] = self.config.m_site_cookie.strip()
        for key, value in self.config.m_site_extra_headers.items():
            if key and value:
                headers[key] = value
        return headers

    def _raise_if_waf_blocked(self, raw: str) -> None:
        markers = ["aliyun_waf", "captcha-element", "waf_nC_h5", "renderData"]
        lower_raw = raw.lower()
        if not raw.lstrip().startswith("<") and not any(marker in lower_raw for marker in markers):
            return

        details: dict[str, Any] = {}
        trace_match = re.search(r'"traceid":"([^"]+)"', raw)
        if trace_match:
            details["traceid"] = trace_match.group(1)
        scene_match = re.search(r'"sceneId":"([^"]+)"', raw)
        if scene_match:
            details["scene_id"] = scene_match.group(1)
        token_match = re.search(r'"token":"([^"]+)"', raw)
        if token_match:
            details["token"] = token_match.group(1)
        raise WafBlockedError("flight-level query blocked by aliyun waf", details)


class MonitorService:
    def __init__(self, config_path: Path, state_path: Path) -> None:
        self.config_path = config_path
        self.state_path = state_path
        self.config = AppConfig.load(config_path)
        self.state = AppState.load(state_path)
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.poll_event = threading.Event()
        self.thread: threading.Thread | None = None
        if self.state.effective_poll_interval_seconds is None:
            self.state.effective_poll_interval_seconds = self.config.poll_interval_seconds

    def start(self) -> None:
        self.thread = threading.Thread(target=self._run_loop, name="ceair-monitor", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.poll_event.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=2)

    def _run_loop(self) -> None:
        try:
            self.poll_once()
        except Exception:  # noqa: BLE001
            pass
        while not self.stop_event.is_set():
            with self.lock:
                timeout_seconds = self.state.effective_poll_interval_seconds or self.config.poll_interval_seconds
            self.poll_event.wait(timeout=timeout_seconds)
            self.poll_event.clear()
            if self.stop_event.is_set():
                break
            try:
                self.poll_once()
            except Exception:  # noqa: BLE001
                pass

    def request_poll(self) -> None:
        self.poll_event.set()

    def update_config(self, patch: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "poll_interval_seconds",
            "start_offset_days",
            "days_ahead",
            "weekdays",
            "origin_codes",
            "destination_codes",
            "product_code",
            "route_type",
            "index_no",
            "channel_code",
            "sales_channel",
            "serverchan_sendkey",
            "serverchan_sendkeys",
            "request_timeout_seconds",
            "backoff_step_seconds",
            "max_poll_interval_seconds",
            "flight_level_enabled",
            "browser_user_agent",
            "m_site_cookie",
            "m_site_extra_headers",
            "playwright_headless",
            "playwright_storage_state_path",
            "playwright_timeout_ms",
            "playwright_user_data_dir",
            "playwright_browser_channel",
            "playwright_locale",
            "playwright_timezone_id",
            "playwright_viewport_width",
            "playwright_viewport_height",
            "playwright_is_mobile",
            "playwright_has_touch",
            "playwright_device_scale_factor",
            "rules",
        }
        with self.lock:
            for key, value in patch.items():
                if key not in allowed:
                    raise ValueError(f"unsupported config field: {key}")
                setattr(self.config, key, value)
            if self.state.effective_poll_interval_seconds is None:
                self.state.effective_poll_interval_seconds = self.config.poll_interval_seconds
            self.config.save(self.config_path)
            self.state.save(self.state_path)
        self.request_poll()
        return asdict(self.config)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {
                "config": asdict(self.config),
                "state": asdict(self.state),
            }

    def _build_browser_probe(self, config: AppConfig) -> Any:
        try:
            from ceair.browser import BrowserProbeConfig, PlaywrightFlightProbe
        except ModuleNotFoundError as exc:
            if exc.name == "playwright":
                raise RuntimeError(
                    "playwright is not installed; install optional browser support before using browser probe"
                ) from exc
            raise

        return PlaywrightFlightProbe(
            BrowserProbeConfig(
                headless=config.playwright_headless,
                user_agent=config.browser_user_agent,
                storage_state_path=config.playwright_storage_state_path,
                timeout_ms=config.playwright_timeout_ms,
                user_data_dir=config.playwright_user_data_dir,
                browser_channel=config.playwright_browser_channel,
                locale=config.playwright_locale,
                timezone_id=config.playwright_timezone_id,
                viewport_width=config.playwright_viewport_width,
                viewport_height=config.playwright_viewport_height,
                is_mobile=config.playwright_is_mobile,
                has_touch=config.playwright_has_touch,
                device_scale_factor=config.playwright_device_scale_factor,
            )
        )

    def _browser_probe(self, query: dict[str, Any], config: AppConfig) -> dict[str, Any]:
        probe = self._build_browser_probe(config)
        return probe.probe(
            dep_date=dt.date.fromisoformat(query["date"]),
            origin_code=query["origin"],
            destination_code=query["destination"],
            product_code=query["product_code"],
            route_type=query["route_type"],
        )

    def _normalize_http_flights(self, response: dict[str, Any]) -> list[dict[str, Any]]:
        normalized_flights = []
        for flight in response.get("data", {}).get("flights", []):
            normalized_flights.append(
                {
                    "flight_no": flight.get("flightNo")
                    or flight.get("marketingFlightNo")
                    or flight.get("flightCode")
                    or "",
                    "dep_time": flight.get("depTime") or "",
                    "arr_time": flight.get("arrTime") or "",
                    "flight_key": flight.get("flightKey") or "",
                }
            )
        return normalized_flights

    def poll_once(self) -> dict[str, Any]:
        with self.lock:
            config = self.config
            client = CeairClient(config)
            notifier = ServerChanNotifier(normalize_sendkeys(config), config.request_timeout_seconds)

        try:
            self._maybe_reset_daily_state()
            summary = self._collect_summary(client, config)
            events = self._detect_events(summary, config)
            notification = self._notify(events, notifier, config)
            with self.lock:
                self.state.last_poll_at = now_local().isoformat()
                self.state.last_error = None
                self.state.last_summary = summary
                self.state.events.extend(events)
                self.state.events = self.state.events[-50:]
                self.state.last_summary["notification"] = notification
                self.state.save(self.state_path)
            return summary
        except Exception as exc:  # noqa: BLE001
            self._handle_poll_error(exc, notifier, config)
            with self.lock:
                self.state.last_poll_at = now_local().isoformat()
                self.state.last_error = str(exc)
                self.state.save(self.state_path)
            raise

    def send_test_notification(self) -> dict[str, Any]:
        with self.lock:
            config = self.config
            notifier = ServerChanNotifier(normalize_sendkeys(config), config.request_timeout_seconds)

        title = "东航趣游卡通知测试"
        body = "可兑换票日期 2026-04-28，周二"
        return notifier.send(title, body)

    def import_flight_curl(self, curl_command: str) -> dict[str, Any]:
        parsed = parse_curl_command(curl_command)
        headers = parsed["headers"]
        imported_headers = extract_browser_session_headers(headers)

        with self.lock:
            if "User-Agent" in imported_headers:
                self.config.browser_user_agent = imported_headers.pop("User-Agent")
            if "Cookie" in imported_headers:
                self.config.m_site_cookie = imported_headers.pop("Cookie")
            self.config.m_site_extra_headers = imported_headers
            self.config.save(self.config_path)
            self.state.save(self.state_path)

        return {
            "imported": True,
            "url": parsed["url"],
            "method": parsed["method"],
            "body_present": bool(parsed["body"]),
            "browser_user_agent_set": bool(self.config.browser_user_agent),
            "cookie_set": bool(self.config.m_site_cookie),
            "extra_header_keys": sorted(imported_headers.keys()),
        }

    def run_browser_probe(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            config = self.config

        date_text = str(payload.get("date") or "").strip()
        if not date_text:
            raise ValueError("missing date")
        rules = effective_rules(config)
        default_rule = rules[0] if rules else None
        origin = str(payload.get("origin") or "").strip() or (
            default_rule.origin_codes[0] if default_rule and default_rule.origin_codes else ""
        )
        destination = str(payload.get("destination") or "").strip() or (
            default_rule.destination_codes[0] if default_rule and default_rule.destination_codes else ""
        )
        if not origin or not destination:
            raise ValueError("missing origin or destination")
        product_code = str(payload.get("product_code") or "").strip() or (
            default_rule.product_code if default_rule else config.product_code
        )
        route_type = str(payload.get("route_type") or "").strip() or (
            default_rule.route_type if default_rule else config.route_type
        )

        probe = self._build_browser_probe(config)
        return probe.probe(
            dep_date=dt.date.fromisoformat(date_text),
            origin_code=origin,
            destination_code=destination,
            product_code=product_code,
            route_type=route_type,
        )

    def submit_external_flight_result(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            config = self.config
            notifier = ServerChanNotifier(normalize_sendkeys(config), config.request_timeout_seconds)

        date_text = str(payload.get("date") or "").strip()
        origin = str(payload.get("origin") or "").strip().upper()
        destination = str(payload.get("destination") or "").strip().upper()
        if not date_text or not origin or not destination:
            raise ValueError("missing date, origin or destination")
        dt.date.fromisoformat(date_text)

        raw_flights = payload.get("flights")
        if not isinstance(raw_flights, list):
            raise ValueError("flights must be a list")

        normalized_flights: list[dict[str, Any]] = []
        for item in raw_flights:
            if not isinstance(item, dict):
                continue
            flight_no = str(item.get("flight_no") or item.get("flightNo") or item.get("marketingFlightNo") or "").strip()
            dep_time = str(item.get("dep_time") or item.get("depTime") or "").strip()
            arr_time = str(item.get("arr_time") or item.get("arrTime") or "").strip()
            flight_key = str(item.get("flight_key") or item.get("flightKey") or "").strip()
            if not flight_no or not dep_time:
                continue
            normalized_flights.append(
                {
                    "flight_no": flight_no,
                    "dep_time": dep_time,
                    "arr_time": arr_time,
                    "flight_key": flight_key,
                }
            )

        rules = effective_rules(config)
        matched_rules: list[dict[str, Any]] = []
        for rule in rules:
            if origin not in rule.origin_codes or destination not in rule.destination_codes:
                continue
            if not weekday_matches(date_text, rule.weekdays):
                continue

            matched_flights = [
                flight
                for flight in normalized_flights
                if time_matches(flight["dep_time"], rule.start_time, rule.end_time)
            ]
            matched_rules.append(
                {
                    "rule_name": rule.name,
                    "origin": origin,
                    "destination": destination,
                    "date": date_text,
                    "time_window": {
                        "start": rule.start_time,
                        "end": rule.end_time,
                        "label": time_window_label(rule.start_time, rule.end_time),
                    },
                    "matched_flights": matched_flights,
                }
            )

        with self.lock:
            previous_flight_keys = set(self.state.previous_flight_keys)

        events: list[dict[str, Any]] = []
        current_flight_keys = set(previous_flight_keys)
        for item in matched_rules:
            for flight in item["matched_flights"]:
                event_key = flight_event_key(
                    item["rule_name"],
                    item["origin"],
                    item["destination"],
                    item["date"],
                    flight["flight_no"],
                    flight["dep_time"],
                )
                current_flight_keys.add(event_key)
                if event_key in previous_flight_keys:
                    continue
                events.append(
                    {
                        "type": "flight_window_opened",
                        "rule_name": item["rule_name"],
                        "route": f"{item['origin']}-{item['destination']}",
                        "origin": item["origin"],
                        "destination": item["destination"],
                        "date": item["date"],
                        "flight_no": flight["flight_no"],
                        "dep_time": flight["dep_time"],
                        "arr_time": flight["arr_time"],
                        "flight_key": flight["flight_key"],
                        "time_window": item["time_window"],
                        "detected_at": now_local().isoformat(),
                    }
                )

        notification = self._notify(events, notifier, config)
        result = {
            "accepted": True,
            "source": str(payload.get("source") or "external"),
            "route": f"{origin}-{destination}",
            "date": date_text,
            "flight_count": len(normalized_flights),
            "matched_rules": matched_rules,
            "new_event_count": len(events),
            "notification": notification,
        }

        with self.lock:
            self.state.previous_flight_keys = sorted(current_flight_keys)
            self.state.last_external_flight_result = result
            self.state.events.extend(events)
            self.state.events = self.state.events[-50:]
            if isinstance(self.state.last_summary, dict):
                self.state.last_summary["external_flight_result"] = result
            self.state.save(self.state_path)

        return result

    def _maybe_reset_daily_state(self) -> None:
        now = now_local()
        reset_date = now.date().isoformat()
        if now.hour < 7:
            return

        with self.lock:
            if self.state.last_daily_reset_date == reset_date:
                return
            self.state.previous_statuses = {}
            self.state.previous_flight_keys = []
            self.state.events = []
            self.state.last_daily_reset_date = reset_date
            self.state.save(self.state_path)

    def _is_rate_limited_error(self, exc: Exception) -> bool:
        if isinstance(exc, urllib.error.HTTPError):
            return exc.code in {403, 429, 503}
        text = str(exc).lower()
        keywords = [
            "429",
            "403",
            "too many requests",
            "rate limit",
            "forbidden",
            "temporarily blocked",
            "service unavailable",
        ]
        return any(keyword in text for keyword in keywords)

    def _handle_poll_error(
        self,
        exc: Exception,
        notifier: ServerChanNotifier,
        config: AppConfig,
    ) -> None:
        if not self._is_rate_limited_error(exc):
            return

        with self.lock:
            current_interval = self.state.effective_poll_interval_seconds or config.poll_interval_seconds
            next_interval = min(current_interval + config.backoff_step_seconds, config.max_poll_interval_seconds)
            self.state.effective_poll_interval_seconds = next_interval
            self.state.save(self.state_path)

        title = "东航趣游卡轮询策略调整"
        body = "\n".join(
            [
                f"检测到疑似风控或限流：{type(exc).__name__}",
                f"原轮询间隔 {current_interval // 60} 分钟",
                f"调整后轮询间隔 {next_interval // 60} 分钟",
                "服务将按新的间隔继续轮询。",
            ]
        )
        try:
            notifier.send(title, body)
        except Exception:  # noqa: BLE001
            pass

    def _collect_summary(self, client: CeairClient, config: AppConfig) -> dict[str, Any]:
        today = now_local().date()
        start_date = today + dt.timedelta(days=config.start_offset_days)
        end_date = start_date + dt.timedelta(days=config.days_ahead)
        monitored_dates = {day.isoformat(): day for day in date_range(start_date, end_date)}
        rules = effective_rules(config)
        route_results: list[dict[str, Any]] = []
        current_statuses: dict[str, str] = {}
        redeemable_dates: list[dict[str, Any]] = []
        rule_matches: list[dict[str, Any]] = []
        flight_level = {
            "enabled": config.flight_level_enabled,
            "attempted_dates": [],
            "flights_by_date": {},
            "status": "disabled" if not config.flight_level_enabled else "not_run",
            "sources_by_date": {},
        }
        route_queries: dict[str, dict[str, Any]] = {}
        for rule in rules:
            for origin in rule.origin_codes:
                for destination in rule.destination_codes:
                    route_queries.setdefault(
                        f"{origin}-{destination}",
                        {
                            "origin": origin,
                            "destination": destination,
                            "product_code": rule.product_code,
                            "route_type": rule.route_type,
                            "index_no": rule.index_no,
                            "channel_code": rule.channel_code,
                            "sales_channel": rule.sales_channel,
                        },
                    )

        route_statuses: dict[str, dict[str, str]] = {}
        for route_key, route_query in sorted(route_queries.items()):
            route_map: dict[str, str] = {}
            chunk_start = start_date
            while chunk_start <= end_date:
                chunk_result = client.query_redeemable_dates(
                    chunk_start,
                    route_query["origin"],
                    route_query["destination"],
                    route_query["product_code"],
                    route_query["route_type"],
                    route_query["index_no"],
                    route_query["channel_code"],
                    route_query["sales_channel"],
                )
                for date_text, status in chunk_result.items():
                    if date_text in monitored_dates:
                        route_map[date_text] = status
                chunk_start += dt.timedelta(days=7)

            for date_text, status in sorted(route_map.items()):
                current_statuses[f"{route_key}:{date_text}"] = status
            route_statuses[route_key] = dict(sorted(route_map.items()))
            route_results.append({"route": route_key, "statuses": route_statuses[route_key]})

        for rule in rules:
            for origin in rule.origin_codes:
                for destination in rule.destination_codes:
                    route_key = f"{origin}-{destination}"
                    for date_text, status in sorted(route_statuses.get(route_key, {}).items()):
                        if status != "2" or not weekday_matches(date_text, rule.weekdays):
                            continue
                        match_item = {
                            "rule_name": rule.name,
                            "origin": origin,
                            "destination": destination,
                            "date": date_text,
                            "status": status,
                            "time_window": {
                                "start": rule.start_time,
                                "end": rule.end_time,
                                "label": time_window_label(rule.start_time, rule.end_time),
                            },
                            "requires_flight_level": rule.has_time_window(),
                            "matched_flights": [],
                            "flight_check_status": "pending" if rule.has_time_window() else "not_needed",
                            "product_code": rule.product_code,
                            "route_type": rule.route_type,
                            "sales_channel": rule.sales_channel,
                        }
                        redeemable_dates.append(
                            {
                                "rule_name": rule.name,
                                "origin": origin,
                                "destination": destination,
                                "date": date_text,
                                "status": status,
                            }
                        )
                        rule_matches.append(match_item)

        flight_queries: dict[str, dict[str, Any]] = {}
        for item in rule_matches:
            if not item["requires_flight_level"]:
                continue
            flight_queries.setdefault(
                f"{item['origin']}-{item['destination']}:{item['date']}",
                {
                    "origin": item["origin"],
                    "destination": item["destination"],
                    "date": item["date"],
                    "product_code": item["product_code"],
                    "route_type": item["route_type"],
                    "sales_channel": item["sales_channel"],
                },
            )

        if config.flight_level_enabled and flight_queries:
            flight_level["status"] = "ok"
            for attempt_key, query in sorted(flight_queries.items()):
                flight_level["attempted_dates"].append(attempt_key)
                route_key = f"{query['origin']}-{query['destination']}"
                source = "http"
                try:
                    response = client.query_flights(
                        dt.date.fromisoformat(query["date"]),
                        query["origin"],
                        query["destination"],
                        query["product_code"],
                        query["route_type"],
                        query["sales_channel"],
                    )
                except Exception as exc:  # noqa: BLE001
                    response = None
                    source = "browser"
                    try:
                        browser_report = self._browser_probe(query, config)
                    except Exception as browser_exc:  # noqa: BLE001
                        flight_level["status"] = "error"
                        flight_level["error"] = {
                            "date": query["date"],
                            "route": route_key,
                            "message": f"browser probe failed: {browser_exc}",
                        }
                        flight_level["sources_by_date"][attempt_key] = {
                            "source": source,
                            "status": "failed",
                            "message": str(browser_exc),
                        }
                        continue

                    browser_status = browser_report.get("status", "not_observed")
                    flight_level["sources_by_date"][attempt_key] = {
                        "source": source,
                        "status": browser_status,
                    }
                    if isinstance(exc, WafBlockedError):
                        flight_level["blocked"] = {
                            "date": query["date"],
                            "route": route_key,
                            "message": str(exc),
                            "details": exc.details,
                        }
                    if browser_status == "waf_blocked":
                        flight_level["status"] = "waf_blocked"
                    elif browser_status in {"timeout", "not_observed"}:
                        flight_level["status"] = "error"
                        flight_level["error"] = {
                            "date": query["date"],
                            "route": route_key,
                            "message": f"browser probe {browser_status}",
                        }
                    if browser_report.get("flights"):
                        flight_level["flights_by_date"][attempt_key] = browser_report["flights"]
                        flight_level["sources_by_date"][attempt_key]["flight_count"] = len(browser_report["flights"])
                    continue

                normalized_flights = self._normalize_http_flights(response)
                flight_level["flights_by_date"][attempt_key] = normalized_flights
                flight_level["sources_by_date"][attempt_key] = {
                    "source": source,
                    "status": "ok",
                    "flight_count": len(normalized_flights),
                }

        for item in rule_matches:
            if not item["requires_flight_level"]:
                continue
            attempt_key = f"{item['origin']}-{item['destination']}:{item['date']}"
            if not config.flight_level_enabled:
                item["flight_check_status"] = "disabled"
                continue
            if flight_level["status"] == "waf_blocked":
                item["flight_check_status"] = "waf_blocked"
                continue
            if attempt_key not in flight_level["flights_by_date"]:
                item["flight_check_status"] = "not_available"
                continue

            matched_flights = [
                flight
                for flight in flight_level["flights_by_date"][attempt_key]
                if flight.get("dep_time") and time_matches(
                    flight["dep_time"],
                    item["time_window"]["start"],
                    item["time_window"]["end"],
                )
            ]
            item["matched_flights"] = matched_flights
            item["flight_check_status"] = "matched" if matched_flights else "no_match"

        return {
            "window": {
                "start_date": start_date.isoformat(),
                "end_date": end_date.isoformat(),
                "days_ahead": config.days_ahead,
            },
            "rules": [rule.to_dict() for rule in rules],
            "routes": route_results,
            "redeemable_dates": sorted(
                redeemable_dates,
                key=lambda item: (item["date"], item["origin"], item["destination"], item["rule_name"]),
            ),
            "rule_matches": sorted(
                rule_matches,
                key=lambda item: (item["date"], item["origin"], item["destination"], item["rule_name"]),
            ),
            "monitored_weekdays": sorted({weekday for rule in rules for weekday in rule.weekdays}),
            "status_count": len(current_statuses),
            "current_statuses": current_statuses,
            "flight_level": flight_level,
        }

    def _detect_events(self, summary: dict[str, Any], config: AppConfig) -> list[dict[str, Any]]:
        with self.lock:
            previous = dict(self.state.previous_statuses)
            previous_flight_keys = set(self.state.previous_flight_keys)

        events: list[dict[str, Any]] = []
        rules_by_name = {rule.name: rule for rule in effective_rules(config)}
        current_statuses: dict[str, str] = summary["current_statuses"]
        for item in summary.get("rule_matches", []):
            if item["requires_flight_level"]:
                continue
            route_key = f"{item['origin']}-{item['destination']}"
            key = f"{route_key}:{item['date']}"
            old_status = previous.get(key)
            if item["status"] == "2" and old_status != "2":
                rule = rules_by_name.get(item["rule_name"])
                if rule and weekday_matches(item["date"], rule.weekdays):
                    events.append(
                        {
                            "type": "redeemable_opened",
                            "rule_name": item["rule_name"],
                            "route": route_key,
                            "origin": item["origin"],
                            "destination": item["destination"],
                            "date": item["date"],
                            "previous_status": old_status,
                            "current_status": item["status"],
                            "detected_at": now_local().isoformat(),
                        }
                    )

        current_flight_keys: set[str] = set()
        for item in summary.get("rule_matches", []):
            if not item["requires_flight_level"]:
                continue
            for flight in item.get("matched_flights", []):
                event_key = flight_event_key(
                    item["rule_name"],
                    item["origin"],
                    item["destination"],
                    item["date"],
                    flight.get("flight_no", ""),
                    flight.get("dep_time", ""),
                )
                current_flight_keys.add(event_key)
                if event_key in previous_flight_keys:
                    continue
                events.append(
                    {
                        "type": "flight_window_opened",
                        "rule_name": item["rule_name"],
                        "route": f"{item['origin']}-{item['destination']}",
                        "origin": item["origin"],
                        "destination": item["destination"],
                        "date": item["date"],
                        "flight_no": flight.get("flight_no", ""),
                        "dep_time": flight.get("dep_time", ""),
                        "arr_time": flight.get("arr_time", ""),
                        "flight_key": flight.get("flight_key", ""),
                        "time_window": item["time_window"],
                        "detected_at": now_local().isoformat(),
                    }
                )

        with self.lock:
            self.state.previous_statuses = current_statuses
            self.state.previous_flight_keys = sorted(current_flight_keys)
        return events

    def _notify(
        self,
        events: list[dict[str, Any]],
        notifier: ServerChanNotifier,
        config: AppConfig,
    ) -> dict[str, Any]:
        if not events:
            return {"sent": False, "reason": "no_new_events"}

        grouped: dict[str, list[str]] = {}
        for event in events:
            if event["type"] == "flight_window_opened":
                grouped.setdefault("flight_level", []).append(
                    "\n".join(
                        [
                            f"{city_label(event['origin'])} -> {city_label(event['destination'])}",
                            f"{event['date']} {weekday_label(event['date'])}",
                            f"起飞时间：{event['dep_time']}",
                            event["flight_no"],
                        ]
                    )
                )
                continue
            route = f"{city_label(event['origin'])} -> {city_label(event['destination'])}"
            grouped.setdefault(route, []).append(event["date"])

        lines = []
        for route, dates in grouped.items():
            if route == "flight_level":
                lines.extend(sorted(dates))
                continue
            for date_text in sorted(dates):
                lines.append(f"{route} 可兑换票日期 {date_text}，{weekday_label(date_text)}")

        title = "东航趣游卡有可兑换票"
        if any(event["type"] == "flight_window_opened" for event in events):
            title = "东航趣游卡命中目标航班"
        body = "\n".join(lines)
        return notifier.send(title, body)


class ApiHandler(http.server.SimpleHTTPRequestHandler):
    service: MonitorService

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _json(self, status_code: int, payload: dict[str, Any]) -> None:
        content = json.dumps(payload, ensure_ascii=False, indent=2).encode()
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/config":
            self._json(200, {"config": self.service.snapshot()["config"]})
            return
        if self.path == "/api/status":
            self._json(200, self.service.snapshot())
            return
        if self.path == "/":
            self._json(
                200,
                {
                    "message": "Ceair monitor service",
                    "endpoints": [
                        "GET /api/config",
                        "PATCH /api/config",
                        "GET /api/status",
                        "POST /api/poll",
                        "POST /api/test-notify",
                        "POST /api/flight-result",
                        "POST /api/import-flight-curl",
                        "POST /api/browser-probe",
                        "GET /prototype/index.html",
                        "GET /docs/spec.md",
                    ],
                },
            )
            return
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/poll":
            self.service.request_poll()
            self._json(202, {"queued": True})
            return
        if self.path == "/api/test-notify":
            try:
                result = self.service.send_test_notification()
            except Exception as exc:  # noqa: BLE001
                self._json(500, {"error": str(exc)})
                return
            self._json(200, result)
            return
        if self.path == "/api/flight-result":
            length = int(self.headers.get("Content-Length", "0"))
            try:
                payload = json.loads(self.rfile.read(length).decode() or "{}")
                result = self.service.submit_external_flight_result(payload)
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid json"})
                return
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
                return
            except Exception as exc:  # noqa: BLE001
                self._json(500, {"error": str(exc)})
                return
            self._json(200, result)
            return
        if self.path == "/api/import-flight-curl":
            length = int(self.headers.get("Content-Length", "0"))
            try:
                payload = json.loads(self.rfile.read(length).decode() or "{}")
                curl_command = str(payload.get("curl", "")).strip()
                if not curl_command:
                    self._json(400, {"error": "missing curl"})
                    return
                result = self.service.import_flight_curl(curl_command)
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid json"})
                return
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
                return
            self._json(200, result)
            return
        if self.path == "/api/browser-probe":
            length = int(self.headers.get("Content-Length", "0"))
            try:
                payload = json.loads(self.rfile.read(length).decode() or "{}")
                result = self.service.run_browser_probe(payload)
            except json.JSONDecodeError:
                self._json(400, {"error": "invalid json"})
                return
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
                return
            except Exception as exc:  # noqa: BLE001
                self._json(500, {"error": str(exc)})
                return
            self._json(200, result)
            return
        self._json(404, {"error": "not found"})

    def do_PATCH(self) -> None:  # noqa: N802
        if self.path != "/api/config":
            self._json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length).decode() or "{}")
            config = self.service.update_config(payload)
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
            return

        self._json(200, {"config": config})

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return


def parse_curl_command(curl_command: str) -> dict[str, Any]:
    try:
        tokens = shlex.split(curl_command)
    except ValueError as exc:
        raise ValueError(f"invalid curl command: {exc}") from exc

    if not tokens or tokens[0] != "curl":
        raise ValueError("curl command must start with curl")

    method = "GET"
    headers: dict[str, str] = {}
    body = ""
    url = ""
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token in {"-X", "--request"}:
            index += 1
            if index >= len(tokens):
                raise ValueError("missing method after -X/--request")
            method = tokens[index].upper()
        elif token in {"-H", "--header"}:
            index += 1
            if index >= len(tokens):
                raise ValueError("missing header after -H/--header")
            header_line = tokens[index]
            if ":" not in header_line:
                raise ValueError(f"invalid header: {header_line}")
            name, value = header_line.split(":", 1)
            headers[name.strip()] = value.strip()
        elif token in {"--data", "--data-raw", "--data-binary", "--data-ascii", "-d"}:
            index += 1
            if index >= len(tokens):
                raise ValueError("missing body after data flag")
            body = tokens[index]
            if method == "GET":
                method = "POST"
        elif token.startswith("http://") or token.startswith("https://"):
            url = token
        index += 1

    return {"method": method, "headers": headers, "body": body, "url": url}


def extract_browser_session_headers(headers: dict[str, str]) -> dict[str, str]:
    allowed_names = {
        "Accept",
        "Accept-Language",
        "Content-Type",
        "Cookie",
        "Origin",
        "Priority",
        "Referer",
        "Sec-CH-UA",
        "Sec-CH-UA-Mobile",
        "Sec-CH-UA-Platform",
        "Sec-Fetch-Dest",
        "Sec-Fetch-Mode",
        "Sec-Fetch-Site",
        "User-Agent",
        "X-Requested-With",
        "salesChannel",
    }
    normalized_allowed = {name.lower(): name for name in allowed_names}
    extracted: dict[str, str] = {}
    for key, value in headers.items():
        normalized = normalized_allowed.get(key.lower())
        if normalized and value.strip():
            extracted[normalized] = value.strip()
    return extracted


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    service = MonitorService(CONFIG_PATH, STATE_PATH)
    service.start()

    handler_class = type("BoundApiHandler", (ApiHandler,), {"service": service})
    server = http.server.ThreadingHTTPServer((service.config.host, service.config.port), handler_class)

    print(f"Monitor API:     http://{service.config.host}:{service.config.port}/api/status")
    print(f"Config endpoint: http://{service.config.host}:{service.config.port}/api/config")
    print(f"Prototype:       http://{service.config.host}:{service.config.port}/prototype/index.html")
    print(f"Spec:            http://{service.config.host}:{service.config.port}/docs/spec.md")
    print(f"Config file:     {CONFIG_PATH}")
    print(f"State file:      {STATE_PATH}")
    print(f"Base interval:   {service.config.poll_interval_seconds}s")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        service.stop()
        server.server_close()


if __name__ == "__main__":
    main()
