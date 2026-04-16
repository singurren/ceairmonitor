from __future__ import annotations

import datetime as dt
import json
import os
from argparse import ArgumentParser
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

CITY_LABELS = {
    "SHA": "上海",
    "PVG": "上海",
    "SZX": "深圳",
}


def build_flight_list_url(
    origin_code: str,
    destination_code: str,
    dep_date: dt.date,
    product_code: str,
    route_type: str = "OW",
) -> str:
    trip_type = 0 if route_type == "OW" else 1
    payload = {
        "tripType": trip_type,
        "depCode": origin_code,
        "arrCode": destination_code,
        "dt": "1",
        "at": "1",
        "depN": city_label(origin_code),
        "arrN": city_label(destination_code),
        "flightDate": dep_date.strftime("%Y%m%d"),
        "carryChd": "0",
        "carryInf": "0",
        "productType": "CASH",
        "curIndex": 0,
        "zoneCode": "PROMOTION_PRODUCT_ZONE",
        "productCode": product_code,
    }
    return "https://m.ceair.com/mapp/reserve/flightList?newParam=" + quote(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )


@dataclass
class BrowserProbeConfig:
    headless: bool
    user_agent: str
    storage_state_path: str
    timeout_ms: int
    user_data_dir: str = "data/playwright-user-data"
    browser_channel: str = ""
    locale: str = "zh-CN"
    timezone_id: str = "Asia/Shanghai"
    viewport_width: int = 390
    viewport_height: int = 844
    is_mobile: bool = True
    has_touch: bool = True
    device_scale_factor: float = 3.0


class PlaywrightFlightProbe:
    def __init__(self, config: BrowserProbeConfig) -> None:
        self.config = config

    def probe(
        self,
        dep_date: dt.date,
        origin_code: str,
        destination_code: str,
        product_code: str,
        route_type: str = "OW",
    ) -> dict[str, Any]:
        url = build_flight_list_url(origin_code, destination_code, dep_date, product_code, route_type)
        report: dict[str, Any] = {
            "target_url": url,
            "headless": self.config.headless,
            "storage_state_path": self.config.storage_state_path,
            "user_data_dir": self.config.user_data_dir,
            "browser_channel": self.config.browser_channel,
            "shoppingv2": [],
            "flights": [],
        }

        storage_state = self._resolve_storage_state()
        with sync_playwright() as p:
            context, browser = self._launch_context(p, storage_state)
            page = context.new_page()
            page.set_default_timeout(self.config.timeout_ms)

            def on_response(response) -> None:  # type: ignore[no-untyped-def]
                if "m-base/sale/shoppingv2" not in response.url:
                    return
                item: dict[str, Any] = {
                    "url": response.url,
                    "status": response.status,
                    "content_type": response.headers.get("content-type", ""),
                }
                try:
                    if "application/json" in item["content_type"]:
                        data = response.json()
                        item["json_summary"] = summarize_shoppingv2_response(data)
                        item["flights"] = normalize_shoppingv2_flights(data)
                    else:
                        body = response.text()
                        item["body_markers"] = detect_page_markers(body)
                        item["body_preview"] = body[:500]
                except Exception as exc:  # noqa: BLE001
                    item["parse_error"] = str(exc)
                report["shoppingv2"].append(item)

            context.on("response", on_response)
            try:
                page.goto(url, wait_until="domcontentloaded")
                page.wait_for_timeout(5000)
            except PlaywrightTimeoutError as exc:
                report["timeout"] = str(exc)
            finally:
                report["page"] = {
                    "url": page.url,
                    "title": safe_page_title(page),
                    "markers": detect_page_markers(page.content()),
                }
                report["cookies"] = context.cookies()
                context.close()
                if browser is not None:
                    browser.close()

        report["shoppingv2_count"] = len(report["shoppingv2"])
        report["flights"] = collect_probe_flights(report["shoppingv2"])
        report["status"] = summarize_probe_status(report)
        return report

    def _resolve_storage_state(self) -> str | None:
        path = Path(self.config.storage_state_path)
        if path.exists():
            return str(path)
        return None

    def _launch_context(self, playwright: Any, storage_state: str | None) -> tuple[Any, Any | None]:
        context_options = {
            "user_agent": self.config.user_agent,
            "locale": self.config.locale,
            "timezone_id": self.config.timezone_id,
            "viewport": {
                "width": self.config.viewport_width,
                "height": self.config.viewport_height,
            },
            "screen": {
                "width": self.config.viewport_width,
                "height": self.config.viewport_height,
            },
            "is_mobile": self.config.is_mobile,
            "has_touch": self.config.has_touch,
            "device_scale_factor": self.config.device_scale_factor,
        }
        launch_options: dict[str, Any] = {
            "headless": self.config.headless,
        }
        if self.config.browser_channel.strip():
            launch_options["channel"] = self.config.browser_channel.strip()

        user_data_dir = Path(self.config.user_data_dir)
        user_data_dir.mkdir(parents=True, exist_ok=True)
        if any(user_data_dir.iterdir()):
            context = playwright.chromium.launch_persistent_context(
                str(user_data_dir),
                **launch_options,
                **context_options,
            )
            context.set_default_timeout(self.config.timeout_ms)
            return context, None

        browser = playwright.chromium.launch(**launch_options)
        if storage_state:
            context = browser.new_context(storage_state=storage_state, **context_options)
        else:
            context = browser.new_context(**context_options)
        context.set_default_timeout(self.config.timeout_ms)
        return context, browser


def city_label(code: str) -> str:
    return CITY_LABELS.get(code.upper(), code.upper())


def detect_page_markers(html: str) -> dict[str, bool]:
    lower = html.lower()
    return {
        "has_waf_marker": "aliyun_waf" in lower or "captcha-element" in lower or "waf_nc_h5" in lower,
        "has_slider_hint": "滑块" in html or "slider" in lower or "captcha" in lower,
        "has_flight_list_hint": "shoppingv2" in lower or "flightlist" in lower or "航班" in html,
    }


def summarize_shoppingv2_response(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        return {"kind": type(data).__name__}
    flights = data.get("data", {}).get("flights", [])
    return {
        "keys": sorted(data.keys()),
        "flight_count": len(flights) if isinstance(flights, list) else 0,
        "success": data.get("success"),
        "code": data.get("code"),
        "message": data.get("message") or data.get("msg"),
    }


def normalize_shoppingv2_flights(data: Any) -> list[dict[str, Any]]:
    if not isinstance(data, dict):
        return []
    flights = data.get("data", {}).get("flights", [])
    if not isinstance(flights, list):
        return []

    normalized: list[dict[str, Any]] = []
    for flight in flights:
        if not isinstance(flight, dict):
            continue
        normalized.append(
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
    return normalized


def collect_probe_flights(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flights: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in items:
        for flight in item.get("flights", []):
            key = (str(flight.get("flight_no", "")), str(flight.get("dep_time", "")))
            if key in seen:
                continue
            seen.add(key)
            flights.append(flight)
    return flights


def summarize_probe_status(report: dict[str, Any]) -> str:
    if report.get("flights"):
        return "ok"
    if any(item.get("status") == 405 for item in report.get("shoppingv2", [])):
        return "waf_blocked"
    if any(item.get("body_markers", {}).get("has_waf_marker") for item in report.get("shoppingv2", [])):
        return "waf_blocked"
    if any(item.get("body_markers", {}).get("has_slider_hint") for item in report.get("shoppingv2", [])):
        return "captcha_required"
    if report.get("page", {}).get("markers", {}).get("has_waf_marker"):
        return "waf_blocked"
    if report.get("page", {}).get("markers", {}).get("has_slider_hint"):
        return "captcha_required"
    if report.get("shoppingv2_count", 0) > 0:
        return "empty"
    if report.get("timeout"):
        return "timeout"
    return "not_observed"


def safe_page_title(page: Any) -> str:
    try:
        return page.title()
    except Exception:  # noqa: BLE001
        return ""


def save_storage_state(
    output_path: str,
    user_agent: str,
    headless: bool,
    timeout_ms: int,
    target_url: str,
    user_data_dir: str,
    browser_channel: str,
    locale: str,
    timezone_id: str,
    viewport_width: int,
    viewport_height: int,
    is_mobile: bool,
    has_touch: bool,
    device_scale_factor: float,
) -> dict[str, Any]:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        launch_options: dict[str, Any] = {"headless": headless}
        if browser_channel.strip():
            launch_options["channel"] = browser_channel.strip()
        user_data_path = Path(user_data_dir)
        user_data_path.mkdir(parents=True, exist_ok=True)
        context = p.chromium.launch_persistent_context(
            str(user_data_path),
            **launch_options,
            user_agent=user_agent,
            locale=locale,
            timezone_id=timezone_id,
            viewport={"width": viewport_width, "height": viewport_height},
            screen={"width": viewport_width, "height": viewport_height},
            is_mobile=is_mobile,
            has_touch=has_touch,
            device_scale_factor=device_scale_factor,
        )
        page = context.new_page()
        page.set_default_timeout(timeout_ms)
        if target_url:
            page.goto(target_url, wait_until="domcontentloaded")
        print(f"当前页面：{page.url}")
        print("请在浏览器中手动完成东航页面验证或登录。")
        print("完成后回到终端按回车，保存 storage state。")
        input()
        context.storage_state(path=str(path))
        result = {
            "saved": True,
            "path": str(path),
            "user_data_dir": str(user_data_path),
            "page_url": page.url,
            "title": safe_page_title(page),
            "markers": detect_page_markers(page.content()),
            "size": path.stat().st_size if path.exists() else 0,
        }
        context.close()
        return result


def main_save_storage_state() -> None:
    parser = ArgumentParser(description="Open a Playwright browser and save storage state after manual verification.")
    parser.add_argument("--output", default="data/playwright-storage-state.json")
    parser.add_argument("--user-agent", default=os.environ.get("CEAIR_BROWSER_UA", ""))
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--timeout-ms", type=int, default=45000)
    parser.add_argument("--target-url", default="https://m.ceair.com/")
    parser.add_argument("--user-data-dir", default="data/playwright-user-data")
    parser.add_argument("--browser-channel", default=os.environ.get("CEAIR_BROWSER_CHANNEL", ""))
    parser.add_argument("--locale", default=os.environ.get("CEAIR_BROWSER_LOCALE", "zh-CN"))
    parser.add_argument("--timezone-id", default=os.environ.get("CEAIR_BROWSER_TIMEZONE", "Asia/Shanghai"))
    parser.add_argument("--viewport-width", type=int, default=390)
    parser.add_argument("--viewport-height", type=int, default=844)
    parser.add_argument("--is-mobile", action="store_true", default=True)
    parser.add_argument("--no-mobile", action="store_false", dest="is_mobile")
    parser.add_argument("--has-touch", action="store_true", default=True)
    parser.add_argument("--no-touch", action="store_false", dest="has_touch")
    parser.add_argument("--device-scale-factor", type=float, default=3.0)
    args = parser.parse_args()

    user_agent = args.user_agent.strip() or (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/135.0.0.0 Safari/537.36"
    )
    result = save_storage_state(
        output_path=args.output,
        user_agent=user_agent,
        headless=args.headless,
        timeout_ms=args.timeout_ms,
        target_url=args.target_url,
        user_data_dir=args.user_data_dir,
        browser_channel=args.browser_channel,
        locale=args.locale,
        timezone_id=args.timezone_id,
        viewport_width=args.viewport_width,
        viewport_height=args.viewport_height,
        is_mobile=args.is_mobile,
        has_touch=args.has_touch,
        device_scale_factor=args.device_scale_factor,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main_save_storage_state()
