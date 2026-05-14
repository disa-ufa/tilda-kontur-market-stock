# Tilda ↔ Kontur Market Stock Proxy

Сервис для отображения актуальных остатков товаров на сайте Tilda по данным Контур.Маркета.

## Что делает

- получает товары и остатки из Контур.Маркета через API;
- сопоставляет товары по артикулу Tilda и внутреннему `code` Контур.Маркета;
- отдаёт публичный API для сайта Tilda;
- JS-скрипт отображает остаток на странице товара:
  - `В наличии: N шт.`
  - `Нет в наличии`

## Схема работы

Tilda → JS tilda-stock.js → HTTPS API → FastAPI proxy → Kontur Market API

API-ключ Контур.Маркета не хранится в коде Tilda и не попадает в браузер.

## Переменные окружения

На сервере нужен файл `.env`:

KONTUR_API_KEY=your_kontur_api_key
KONTUR_SHOP_ID=your_shop_id
CACHE_TTL_SECONDS=120
CORS_ORIGINS=https://merch-sakh.ru,https://www.merch-sakh.ru

Файл `.env` нельзя коммитить в GitHub.

## Локальный запуск

docker compose up -d --build

Проверка:

curl http://127.0.0.1/health
curl "http://127.0.0.1/api/stock?keys=43,44,45,48"

## Подключение к Tilda

В настройках сайта Tilda → Вставка кода → HEAD:

<script defer src="https://149-154-67-63.sslip.io/tilda-stock.js?v=10"></script>

## Основные файлы

app.py                FastAPI API-прокси
tilda-stock.js        JS-код для Tilda
Dockerfile            Docker-образ приложения
docker-compose.yml    Запуск приложения и Caddy
Caddyfile             HTTPS/reverse proxy
.env.example          пример переменных окружения
requirements.txt      Python-зависимости

## Развёртывание на VPS

1. Создать `.env` на сервере.
2. Запустить сервис:

docker compose up -d --build

3. Проверить:

curl http://127.0.0.1/health
curl "http://127.0.0.1/api/stock?keys=43,44,45,48"

## Безопасность

Не коммитить:

.env
deploy.tar.gz
kontur_debug/
reports/
.venv/

После завершения работ рекомендуется заменить API-ключ Контур.Маркета и пароль root от VPS, так как доступы передавались в переписке.
