# Архитектура PulseDesk

Проверочные модули отделены от доменного слоя, хранения, Telegram и HTTP. Модули не отправляют сообщения и не пишут SQL: они валидируют конфигурацию и возвращают измерение.

```mermaid
flowchart LR
  T[Telegram: команды и кнопки] --> R[BotRouter]
  W[Панель и HTTP API] --> A[Проверка доступа]
  A --> M[MonitoringService]
  R --> M
  S[Runtime: расписание] --> M
  M --> P[ModuleRegistry]
  P --> H[HTTP]
  P --> C[Контент]
  P --> L[TLS]
  H & C & L --> N[Сетевая политика и transport]
  M --> D[(SQLite: измерение + инцидент + outbox)]
  D --> O[NotificationWorker]
  O --> G[TelegramTransport]
  G --> U[Подписчики]
```

## Поток события

1. Runtime выбирает до трёх наступивших проверок, начиная с самых просроченных.
2. MonitoringService объединяет параллельные вызовы одной проверки в одну Promise.
3. Модуль выполняет ограниченное сетевое чтение и возвращает `{ healthy, summary, latencyMs, meta }`.
4. Store одной транзакцией `BEGIN IMMEDIATE` сохраняет измерение, состояние, переход инцидента и уведомления подписчиков.
5. Outbox-worker забирает сообщение с lease, отправляет и фиксирует `sent` либо следующую попытку. После пяти неудач — `dead` с ручным повтором.

Webhook-updates сначала сохраняются с уникальным `update_id`, затем подтверждаются HTTP 200 и обрабатываются worker. В polling offset считается по сохранённым ID. Дедупликация inbox не даёт exactly-once гарантии внешних побочных эффектов при аварии.

## Новый модуль

Создай `src/modules/<name>/index.cjs` и зарегистрируй его в `src/modules/index.cjs`. Модули — доверенный серверный код владельца, не загружаемые пользовательские JavaScript-файлы.

Пример расширения для JSON health-check, использующего общий безопасный HTTPS-транспорт:

```javascript
'use strict'
const { validateUrl } = require('../../core/network.cjs')
module.exports = {
  id: 'json-health',
  title: 'JSON health-check',
  command: '/json',
  description: 'Проверяет поле status в JSON-ответе API.',
  fields: [{ key: 'target', label: 'HTTPS API', required: true }],
  fromCommand(args) {
    const [target, name] = args.split('|').map(part => part.trim())
    return { target, name: name || 'JSON API' }
  },
  validate(input) {
    return { target: validateUrl(input.target).href, config: {} }
  },
  async check(monitor, context) {
    const response = await context.transport.http(monitor.target, {
      signal: context.signal,
    })
    const json = JSON.parse(response.text)
    return {
      healthy: response.status === 200 && json.status === 'ok',
      summary: json.status === 'ok' ? 'API сообщает ok' : 'API сообщает проблему',
      latencyMs: response.latencyMs,
    }
  },
}
```

В реестре добавь `.register(require('./json-health/index.cjs'))`. Пример описывает следующее расширение; JSON health-check не входит в три включённых модуля версии 0.1.0 и требует тестов своего API-контракта.

BotRouter найдёт команду через `command/fromCommand`; `fields` сформируют поля панели; описание попадёт в API и `/help`. История, инциденты, доставка и scheduler останутся общими.

| Поле | Назначение |
| --- | --- |
| `id` | Уникальный идентификатор из латинских строчных букв, цифр и `-` |
| `title`, `description` | Название и описание |
| `command`, `fromCommand(args)` | Telegram-команда и разбор в `{ name, target, config }` |
| `fields` | Поля формы: `key`, `label`, `placeholder`, `required`, `type` |
| `validate(input)` | Нормализация в `{ target, config }`, без сети |
| `check(monitor, context)` | Асинхронный `{ healthy, summary, latencyMs?, meta? }` |

Контекст содержит transport, `now()` и AbortSignal. Используй signal для внешней работы. Ошибка модуля становится отрицательным измерением; отмена при выключении не создаёт ложного инцидента. Новый транспорт требует собственных ограничений адресов, времени и объёма.

## Слои хранения и доступа

- `monitors`, `checks`, `incidents` — состояние и история.
- `subscribers`, `outbox` — подписки и доставка.
- `telegram_updates` — устойчивый inbox.
- `leases` — один фоновый процесс, heartbeat и TTL 60 секунд.
- `migrations` — версия схемы; новые изменения оформляются отдельной миграцией.
- `settings`, `demo_messages` — демонстрационные сценарии.

Live API закрыт отдельным ключом. Webhook использует другой обязательный секрет. Telegram разрешён только явному allowlist и личным чатам. Demo не читает прежний `.env`, не использует live-базу по `PULSE_DATABASE` и не обращается к сети.

## Куда развивать

| Возможность | Слой расширения |
| --- | --- |
| JSON API, DNS, срок домена | Новый модуль и, при необходимости, безопасный транспорт |
| Порог задержки | Настройки HTTP-модуля и критерий инцидента |
| Дайджест | Job с курсором по инцидентам и существующей outbox |
| Email или другой мессенджер | Канальный адаптер и миграция маршрутов доставки |
| Разные роли команды | Модель пользователей и разрешений; allowlist не заменяет RBAC |
| Несколько клиентов | Изоляция проектов во всех запросах, ключах и авторизации |
| Публичное демо | Отдельная demo-база, сессии, ограничения ресурсов и reverse proxy; не снятие loopback-проверки текущего локального режима |

Новый мессенджер является адаптером доставки, а многопользовательская модель требует изменения домена и хранения. Не каждое расширение сводится к одному проверочному модулю.
