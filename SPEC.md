# ТЗ: Интеграция NCRM ↔ Казпочта + Telegram-отчёты

> Документ для Claude Code. Положи в корень проекта и начни с промпта из раздела 13.

## 1. Цель

Автоматически отслеживать статусы посылок Казпочты по трек-кодам из NCRM:
- при изменении статуса — обновлять заказ в NCRM;
- при вручении — менять статус заказа в NCRM на «Получен» (точное название этапа уточняется);
- отправлять уведомления и ежедневные отчёты в Telegram;
- алертить о «зависших» посылках.

**Вне скоупа:** заказы, отправленные курьером (без трек-кода Казпочты). Создание отправлений в Казпочте.

## 2. Стек

| Слой | Технология |
|---|---|
| Язык | TypeScript (strict), Node.js 20 LTS |
| HTTP-сервер | Fastify (Telegram webhook, `/health`) |
| Telegram | grammY |
| БД | PostgreSQL + Prisma |
| Валидация | zod (env, ответы внешних API) |
| HTTP-клиент | undici / нативный fetch + обёртка с ретраями |
| Логи | pino (JSON) |
| Планировщик | in-process scheduler (croner) + Postgres advisory lock |
| Тесты | vitest |
| Деплой | Railway (Hobby), Dockerfile |

## 3. Архитектура

Hexagonal (ports & adapters). Домен и use cases не знают о NCRM, Казпочте и Telegram — только о портах.

```
            ┌──────────── application (use cases) ────────────┐
 Scheduler →│ SyncShipmentsFromCrm   PollTrackingStatuses      │
 Telegram  →│ PushStatusToCrm        DispatchNotifications     │
            │ BuildDailyReport       DetectStuckShipments      │
            └──────┬──────────────┬──────────────┬─────────────┘
                   │ ports        │              │
             CrmPort        TrackingPort     NotifierPort    Repositories
                   │              │              │                │
          NcrmAdapter    KazpostAdapter   TelegramNotifier   Prisma repos
         (MockCrmAdapter)
```

### Принципы
- **Идемпотентность везде.** Повторный запуск любого джоба не создаёт дублей событий, уведомлений и апдейтов в CRM.
- **Outbox для уведомлений.** Use case пишет уведомление в таблицу `notification_outbox` в той же транзакции, что и смену статуса. Отдельный dispatcher отправляет в Telegram. Ничего не теряется при падении.
- **Обновление CRM только на переходе статуса**, не на каждом опросе. Через очередь `crm_sync_status` в `shipments` (pending/synced/failed) с ретраями.
- **Терминальные статусы не опрашиваются** (DELIVERED, RETURNED).
- **Никакой бизнес-логики в адаптерах** — только транспорт и маппинг DTO → домен.
- **Неизвестный статус Казпочты** → `UNKNOWN` + алерт разработчику с raw-текстом, чтобы дополнить маппинг.

## 4. Структура проекта

```
src/
  config/
    env.ts                  # zod-схема env, fail-fast при старте
  domain/
    shipment.ts             # сущность, переходы статусов
    tracking-status.ts      # enum + isTerminal()
    track-code.ts           # value object, валидация формата
    errors.ts
  application/
    ports/
      crm.port.ts
      tracking.port.ts
      notifier.port.ts
      repositories.ts
    use-cases/
      sync-shipments-from-crm.ts
      poll-tracking-statuses.ts
      push-status-to-crm.ts
      dispatch-notifications.ts
      detect-stuck-shipments.ts
      build-daily-report.ts
  infrastructure/
    crm/
      ncrm.adapter.ts       # TODO после получения доков API
      ncrm.schemas.ts
      mock-crm.adapter.ts   # для разработки до получения API
    tracking/
      kazpost.adapter.ts
      kazpost.schemas.ts
      kazpost-status.mapper.ts
    telegram/
      bot.ts                # команды
      telegram.notifier.ts
      templates.ts          # тексты сообщений
    db/
      prisma.ts
      repositories/*.ts
    http/
      http-client.ts        # timeout, retry, backoff+jitter
      server.ts             # fastify: /health, /telegram/webhook
    scheduler/
      scheduler.ts          # cron-задачи + advisory lock
  shared/
    logger.ts
    clock.ts                # инъекция времени для тестов
    concurrency.ts          # p-limit
  main.ts                   # composition root (ручной DI)
prisma/
  schema.prisma
tests/
  fixtures/kazpost/*.json
  unit/
  integration/
Dockerfile
.env.example
CLAUDE.md
```

## 5. Доменная модель

### TrackingStatus
```
REGISTERED        # принят к отправке
IN_TRANSIT
ARRIVED_AT_OFFICE # в отделении, ждёт получателя
DELIVERED         # вручён — терминальный
RETURNING
RETURNED          # терминальный
UNKNOWN
```

### Фильтр «только Казпочта»
Заказ берётся в работу, если **оба** условия:
1. Способ доставки в NCRM = Казпочта (поле/значение настраивается через env `NCRM_KAZPOST_DELIVERY_VALUE`).
2. Трек-код проходит валидацию `TrackCode` (непустой, после trim и upper-case, совпадает с паттерном из env `TRACK_CODE_REGEX`; дефолт — UPU S10 `^[A-Z]{2}\d{9}[A-Z]{2}$`, расширить после просмотра реальных треков).

Если поле способа доставки в NCRM отсутствует — фильтруем только по наличию валидного трек-кода. Невалидные треки логируем (warn), не падаем.

## 6. Схема БД (Prisma)

```prisma
model Shipment {
  id               String   @id @default(cuid())
  crmOrderId       String   @unique
  trackCode        String   @unique
  status           TrackingStatus @default(REGISTERED)
  rawStatus        String?
  lastEventAt      DateTime?
  lastCheckedAt    DateTime?
  nextCheckAt      DateTime @default(now())
  deliveredAt      DateTime?
  crmSyncStatus    CrmSyncStatus @default(SYNCED)
  crmSyncAttempts  Int      @default(0)
  stuckAlertSentAt DateTime?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  events           TrackingEvent[]
  @@index([nextCheckAt, status])
}

model TrackingEvent {
  id          String   @id @default(cuid())
  shipmentId  String
  status      TrackingStatus
  rawStatus   String
  location    String?
  occurredAt  DateTime
  dedupHash   String   @unique   // sha256(track + rawStatus + occurredAt + location)
  rawPayload  Json
  shipment    Shipment @relation(fields: [shipmentId], references: [id])
}

model NotificationOutbox {
  id         String   @id @default(cuid())
  type       NotificationType   // STATUS_CHANGED, DELIVERED, STUCK, DAILY_REPORT, DEV_ALERT
  dedupKey   String   @unique
  payload    Json
  status     OutboxStatus @default(PENDING)
  attempts   Int      @default(0)
  lastError  String?
  sentAt     DateTime?
  createdAt  DateTime @default(now())
  @@index([status, createdAt])
}

model SyncState {
  key        String   @id     // напр. "ncrm.orders.cursor"
  value      String
  updatedAt  DateTime @updatedAt
}
```

## 7. Use cases

### 7.1 SyncShipmentsFromCrm — каждые 10 мин
- Тянет из NCRM заказы, изменённые после курсора `SyncState["ncrm.orders.cursor"]` (если API не умеет фильтр по `updated_at` — тянет заказы в активных статусах постранично).
- Применяет фильтр «только Казпочта».
- Upsert в `shipments` по `crmOrderId`. Если трек-код у заказа изменился — обновить и сбросить статус.
- Двигает курсор только после успешной обработки всей пачки.

### 7.2 PollTrackingStatuses — каждые 5 мин, обрабатывает due-записи
- Выборка: `nextCheckAt <= now AND status NOT IN (DELIVERED, RETURNED)`, limit `POLL_BATCH_SIZE` (дефолт 50).
- Concurrency `KAZPOST_CONCURRENCY` (дефолт 3), задержка между запросами `KAZPOST_MIN_INTERVAL_MS` (дефолт 300).
- Для каждого: запрос событий → маппинг → вставка новых событий (dedup по `dedupHash`) → если статус изменился, в одной транзакции:
  - обновить `shipment`;
  - `crmSyncStatus = PENDING`;
  - записать уведомление в outbox (`dedupKey = shipmentId:status`).
- **Адаптивный интервал** `nextCheckAt`:
  - REGISTERED / IN_TRANSIT → +2 ч;
  - ARRIVED_AT_OFFICE → +1 ч (близко к вручению);
  - нет событий > 7 дней → +6 ч;
  - ошибка API → экспоненциальный backoff (до 6 ч).
- Ответ «нет информации по треку» — не ошибка, а пустая история (трек ещё не зарегистрирован).

### 7.3 PushStatusToCrm — каждые 2 мин
- Берёт `crmSyncStatus = PENDING | FAILED (attempts < 5)`.
- Маппинг внутреннего статуса → статус/этап NCRM через конфиг `CRM_STATUS_MAP` (JSON в env, напр. `{"DELIVERED":"<id этапа>"}`). Статусы без маппинга в CRM не пушатся.
- Опционально пишет комментарий в заказ: «Казпочта: <rawStatus>, <location>, <дата>».

### 7.4 DispatchNotifications — каждую 1 мин
- Отправляет PENDING из outbox в Telegram, ретраи до 5 раз, учитывает 429 `retry_after`.

### 7.5 DetectStuckShipments — каждый час
- ARRIVED_AT_OFFICE дольше `STUCK_IN_OFFICE_DAYS` (дефолт 5) → алерт «Скоро уйдёт в возврат, позвоните клиенту».
- Нет новых событий дольше `NO_UPDATES_DAYS` (дефолт 10) → алерт.
- Один алерт на посылку (`stuckAlertSentAt`).

### 7.6 BuildDailyReport — один раз в сутки, сразу после опроса (`POLL_CRON`, дефолт `0 8 * * *`, TZ `Asia/Almaty`)
- Проверено треков, вручено (трек + номер сделки), в отделении (число), зависшие, возвраты (трек + номер сделки; сделки переносятся в «КЛИЕНТ НЕ ЗАБРАЛ ОТКАЗ»). Списки «вручено» и «возвраты» — ровно то, что нашёл этот прогон. Статус «В пути» в отчёте не показывается.
- Возврат: любое событие возврата Казпочты → `RETURNED` (терминальный), последующее «вручено» у отправителя доставкой не считается.

## 8. Адаптеры

### 8.1 KazpostAdapter
- `GET https://post.kz/external-api/tracking/api/v2/{track}/events`
- Без авторизации. Публичный, недокументированный → ответ валидируется zod **мягко**: неизвестные поля игнорируются, при несовпадении схемы — `DEV_ALERT` и пропуск записи, без падения всего батча.
- Timeout 10 с, ретраи 3 на 5xx/сетевые ошибки, backoff + jitter, User-Agent приложения.
- `kazpost-status.mapper.ts` — таблица `rawStatus (lowercase, regex) → TrackingStatus`. Заполняется по фикстурам реальных ответов. Покрыть юнит-тестами.
- Фикстуры: сохранить 5–10 реальных ответов разных стадий в `tests/fixtures/kazpost/`.

### 8.2 NcrmAdapter (TODO — после получения доков)
Интерфейс порта фиксируем сейчас, реализацию пишем после:
```ts
interface CrmPort {
  listOrdersUpdatedSince(cursor: string | null): AsyncIterable<CrmOrderPage>;
  updateOrderStatus(orderId: string, crmStatusId: string): Promise<void>;
  addOrderComment(orderId: string, text: string): Promise<void>;
}
interface CrmOrder {
  id: string;
  trackCode: string | null;
  deliveryMethod: string | null;
  status: string;
  customerName?: string;
  updatedAt: Date;
}
```
До получения API — `MockCrmAdapter` с in-memory заказами (несколько с треками Казпочты, несколько курьерских без трека). Переключение через env `CRM_DRIVER=mock|ncrm`.

### 8.3 Telegram
- Webhook на `/telegram/webhook/<secret>` + проверка `X-Telegram-Bot-Api-Secret-Token`.
- Получатели: `TELEGRAM_REPORT_CHAT_IDS` (отчёты), `TELEGRAM_DEV_CHAT_ID` (ошибки и DEV_ALERT).
- Команды только для whitelist `TELEGRAM_ADMIN_IDS`:
  - `/track <код>` — текущий статус и история;
  - `/report` — отчёт прямо сейчас;
  - `/stuck` — список зависших;
  - `/health` — время последних успешных запусков джобов.
- Шаблоны в `templates.ts`, HTML parse mode, экранирование.

Пример уведомления:
```
✅ Вручено
Трек: RR123456789KZ
Заказ: #1042 — Иванов И.
Отделение: Алматы 050000
19.11.2026 14:32
```

## 9. Надёжность и эксплуатация
- **Advisory lock** Postgres на каждый джоб: при двух инстансах или долгом прогоне джоб не запускается параллельно.
- **Graceful shutdown:** SIGTERM → остановить scheduler, дождаться текущих задач (до 25 с), закрыть Prisma.
- **/health:** проверка БД + время последнего успешного прогона каждого джоба; 503, если poll не отрабатывал > 30 мин.
- **Логи:** pino JSON, `correlationId` на каждый прогон джоба, никаких токенов в логах.
- **Алерты разработчику:** необработанные ошибки, 3+ подряд фейла Казпочты или NCRM, неизвестные статусы, изменение схемы ответа.
- **Секреты** только через env. `.env.example` в репо, `.env` в `.gitignore`.

## 10. Конфигурация (env)

```
NODE_ENV=production
PORT=3000
DATABASE_URL=
TZ_REPORTS=Asia/Almaty

CRM_DRIVER=mock            # mock | ncrm
NCRM_BASE_URL=
NCRM_API_KEY=
NCRM_KAZPOST_DELIVERY_VALUE=
CRM_STATUS_MAP={"DELIVERED":""}

KAZPOST_BASE_URL=https://post.kz/external-api/tracking/api/v2
KAZPOST_CONCURRENCY=3
KAZPOST_MIN_INTERVAL_MS=300
TRACK_CODE_REGEX=^[A-Z]{2}\d{9}[A-Z]{2}$
POLL_BATCH_SIZE=50

STUCK_IN_OFFICE_DAYS=5
NO_UPDATES_DAYS=10

TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_PUBLIC_URL=
TELEGRAM_REPORT_CHAT_IDS=
TELEGRAM_DEV_CHAT_ID=
TELEGRAM_ADMIN_IDS=
```

## 11. Тесты
- **Unit:** `TrackCode`, `kazpost-status.mapper` (на фикстурах), переходы статусов `Shipment`, расчёт `nextCheckAt`, фильтр «только Казпочта».
- **Use cases:** с in-memory фейками портов и фиксированным `Clock`: идемпотентность (двойной прогон не даёт дублей), курьерские заказы игнорируются, DELIVERED больше не опрашивается, outbox не дублирует уведомления.
- **Integration:** Prisma на тестовом Postgres (docker compose), адаптер Казпочты на записанных фикстурах (без сети).
- CI-скрипты: `lint`, `typecheck`, `test`.

## 12. Этапы

| Этап | Что | Когда |
|---|---|---|
| 1. Каркас | Структура, env, Prisma-схема, домен, порты, MockCrm, KazpostAdapter, scheduler, Telegram-уведомления, тесты | Сейчас |
| 2. NCRM | NcrmAdapter по докам, маппинг статусов CRM | После получения API |
| 3. Маппинг статусов | Сбор реальных ответов Казпочты, заполнение mapper | Параллельно с 2 |
| 4. Деплой | Railway, webhook, прогон на 10–20 реальных заказах | Перед сдачей |
| 5. Запуск | Неделя наблюдения, донастройка интервалов и алертов | После сдачи |

## 13. Стартовый промпт для Claude Code

```
Прочитай SPEC.md. Создай CLAUDE.md с ключевыми правилами архитектуры из SPEC
(hexagonal, outbox, идемпотентность, strict TS, без логики в адаптерах).
Затем выполни Этап 1: инициализируй проект (pnpm, TS strict, eslint, prettier,
vitest), Prisma-схему, домен, порты, use cases, MockCrmAdapter, KazpostAdapter,
scheduler с advisory lock, Telegram-нотификатор с outbox, /health,
graceful shutdown, Dockerfile, .env.example. NcrmAdapter — только заглушка,
реализующая CrmPort и бросающая NotImplemented. Покрой тестами раздел 11.
Работай по шагам, после каждого шага прогоняй typecheck и тесты.
```

## 14. Чек-лист вопросов по NCRM (взять у клиента завтра)

- [ ] Документация API, базовый URL, способ авторизации (API-ключ / OAuth), срок жизни токена
- [ ] Доступен ли API на текущем тарифе клиента
- [ ] Эндпоинт списка заказов/сделок: пагинация, фильтр по `updated_at` и статусу
- [ ] В каком поле хранится трек-код (стандартное или кастомное поле, его ID)
- [ ] Как отличить Казпочту от курьера (поле «способ доставки» и его значения)
- [ ] Эндпоинт смены статуса/этапа заказа, ID нужных этапов («Отправлен», «Получен», «Возврат»)
- [ ] Можно ли добавлять комментарии к заказу
- [ ] Есть ли вебхуки на создание/изменение заказа
- [ ] Rate limits
- [ ] Тестовый аккаунт или песочница
- [ ] 5–10 реальных трек-кодов в разных стадиях для фикстур
- [ ] Кто получает отчёты (chat ID групп/людей), в какое время ежедневный отчёт
