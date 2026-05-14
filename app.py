import os
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware


load_dotenv()

BASE_URL = "https://api.kontur.ru/market/v1"
CACHE_TTL_SECONDS = int(os.getenv("CACHE_TTL_SECONDS", "120"))

app = FastAPI(title="Tilda Kontur Market Stock Proxy", version="1.1.0")

cors_origins_raw = os.getenv("CORS_ORIGINS", "*").strip()
if cors_origins_raw == "*":
    cors_origins = ["*"]
else:
    cors_origins = [item.strip() for item in cors_origins_raw.split(",") if item.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)

_cache = {
    "expires_at": 0.0,
    "data": None,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_key(value) -> str:
    if value is None:
        return ""

    text = str(value).strip()

    if text.endswith(".0") and text.replace(".", "", 1).isdigit():
        text = text[:-2]

    return text


def format_rest(value: float):
    """
    Для сайта возвращаем остаток красиво:
    3.0 -> 3
    3.5 -> 3.5
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0

    if number.is_integer():
        return int(number)

    return number


def make_display_status(rest: float) -> str:
    rest_value = format_rest(rest)

    if float(rest or 0) > 0:
        return f"В наличии: {rest_value} шт."

    return "Нет в наличии"


def get_items(data):
    if isinstance(data, list):
        return data

    if isinstance(data, dict):
        return data.get("items") or data.get("Items") or []

    return []


def pick(obj: dict, *keys):
    for key in keys:
        if key in obj:
            return obj[key]
    return None


def extract_barcodes(value) -> List[str]:
    if not value:
        return []

    result = []

    if isinstance(value, list):
        for item in value:
            if isinstance(item, str):
                result.append(item)
            elif isinstance(item, dict):
                barcode = (
                    item.get("barcode")
                    or item.get("Barcode")
                    or item.get("value")
                    or item.get("Value")
                    or item.get("code")
                    or item.get("Code")
                )
                if barcode:
                    result.append(str(barcode))
            else:
                result.append(str(item))
    else:
        result.append(str(value))

    return [normalize_key(item) for item in result if normalize_key(item)]


def kontur_headers() -> dict:
    api_key = os.getenv("KONTUR_API_KEY")

    if not api_key:
        raise RuntimeError("KONTUR_API_KEY is not set")

    return {
        "x-kontur-apikey": api_key,
    }


def kontur_get(path: str):
    response = requests.get(
        f"{BASE_URL}{path}",
        headers=kontur_headers(),
        timeout=30,
    )

    response.raise_for_status()
    return response.json()


def get_shop_id() -> str:
    shop_id = os.getenv("KONTUR_SHOP_ID")

    if shop_id:
        return shop_id

    shops_data = kontur_get("/shops")
    shops = get_items(shops_data)

    if not shops:
        raise RuntimeError("No shops found in Kontur Market")

    return normalize_key(pick(shops[0], "id", "Id"))


def make_public_item(item: dict) -> dict:
    return {
        "found": True,
        "available": item["available"],
        "rest": item["rest"],
        "status": item["status"],
        "displayStatus": item["displayStatus"],
        "name": item["name"],
        "code": item["code"],
        "barcode": item["barcode"],
    }


def make_not_found_item() -> dict:
    return {
        "found": False,
        "available": False,
        "rest": 0,
        "status": "Нет в наличии",
        "displayStatus": "Нет в наличии",
        "name": "",
        "code": "",
        "barcode": "",
    }


def fetch_inventory() -> dict:
    shop_id = get_shop_id()

    products_data = kontur_get(f"/shops/{shop_id}/products")
    rests_data = kontur_get(f"/shops/{shop_id}/product-rests")

    products = get_items(products_data)
    rests = get_items(rests_data)

    rests_by_product_id: Dict[str, float] = {}

    for rest_item in rests:
        product_id = normalize_key(pick(rest_item, "productId", "ProductId"))
        rest_value = pick(rest_item, "rest", "Rest") or 0

        try:
            rests_by_product_id[product_id] = float(rest_value)
        except (TypeError, ValueError):
            rests_by_product_id[product_id] = 0.0

    items_by_key: Dict[str, dict] = {}

    total_products = 0
    available_products = 0

    for product in products:
        total_products += 1

        product_id = normalize_key(pick(product, "id", "Id"))
        code = normalize_key(pick(product, "code", "Code"))
        name = str(pick(product, "name", "Name") or "").strip()
        barcodes = extract_barcodes(pick(product, "barcodes", "Barcodes"))

        rest = rests_by_product_id.get(product_id, 0.0)
        available = rest > 0

        if available:
            available_products += 1

        item = {
            "productId": product_id,
            "available": available,
            "rest": format_rest(rest),
            "status": "В наличии" if available else "Нет в наличии",
            "displayStatus": make_display_status(rest),
            "name": name,
            "code": code,
            "barcode": barcodes[0] if barcodes else "",
        }

        aliases = set()

        if product_id:
            aliases.add(product_id)

        if code:
            aliases.add(code)

        for barcode in barcodes:
            aliases.add(barcode)

        for alias in aliases:
            items_by_key[alias] = item

    return {
        "ok": True,
        "shopId": shop_id,
        "generatedAt": now_iso(),
        "productsCount": total_products,
        "availableCount": available_products,
        "notAvailableCount": total_products - available_products,
        "keysCount": len(items_by_key),
        "items": items_by_key,
    }


def get_inventory_cached(force: bool = False) -> dict:
    current_time = time.time()

    if (
        not force
        and _cache["data"] is not None
        and current_time < float(_cache["expires_at"])
    ):
        return _cache["data"]

    data = fetch_inventory()
    _cache["data"] = data
    _cache["expires_at"] = current_time + CACHE_TTL_SECONDS

    return data


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "tilda-kontur-market-stock-proxy",
        "version": "1.1.0",
        "time": now_iso(),
    }


@app.get("/api/stock")
def get_stock(keys: Optional[str] = Query(default=None)):
    inventory = get_inventory_cached()

    if not keys:
        return {
            "ok": True,
            "shopId": inventory["shopId"],
            "generatedAt": inventory["generatedAt"],
            "productsCount": inventory["productsCount"],
            "availableCount": inventory["availableCount"],
            "notAvailableCount": inventory["notAvailableCount"],
            "keysCount": inventory["keysCount"],
            "message": "Pass ?keys=331,2100000002580 to get stock statuses and rest values.",
        }

    requested_keys = [
        normalize_key(item)
        for item in keys.split(",")
        if normalize_key(item)
    ]

    result = {}

    for key in requested_keys:
        item = inventory["items"].get(key)

        if item:
            result[key] = make_public_item(item)
        else:
            result[key] = make_not_found_item()

    return {
        "ok": True,
        "shopId": inventory["shopId"],
        "generatedAt": inventory["generatedAt"],
        "items": result,
    }


@app.get("/api/stock/{key}")
def get_stock_by_key(key: str):
    inventory = get_inventory_cached()
    normalized_key = normalize_key(key)

    item = inventory["items"].get(normalized_key)

    return {
        "ok": True,
        "shopId": inventory["shopId"],
        "generatedAt": inventory["generatedAt"],
        "key": normalized_key,
        "item": make_public_item(item) if item else make_not_found_item(),
    }


@app.get("/api/refresh")
def refresh_cache():
    inventory = get_inventory_cached(force=True)

    return {
        "ok": True,
        "shopId": inventory["shopId"],
        "generatedAt": inventory["generatedAt"],
        "productsCount": inventory["productsCount"],
        "availableCount": inventory["availableCount"],
        "notAvailableCount": inventory["notAvailableCount"],
        "keysCount": inventory["keysCount"],
    }