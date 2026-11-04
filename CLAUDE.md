# CLAUDE.md — NCRM ↔ Казпочта + Telegram

Источник правды: `SPEC.md`. Здесь — только правила, которые нельзя нарушать.

## Что делает сервис
Отслеживает посылки Казпочты по трек-кодам из NCRM, пушит смену статуса в CRM,
шлёт уведомления/отчёты в Telegram, алертит о зависших. Курьерские заказы (без трека) — вне скоупа.

## Стек
TypeScript strict, Node.js 20, pnpm, Fastify, grammY, PostgreSQL + Prisma, zod, pino, croner, vitest.

## Архитектура: hexagonal (ports & adapters)
- `domain/` и `application/` **не импортируют** infrastructure, Prisma, grammY, fetch, Fastify.
  Они знают только порты (`application/ports/*`) и `shared/clock`.
- `infrastructure/*` реализует порты. **Никакой бизнес-логики в адаптерах** — только транспорт,
  валидация ответа (zod) и маппинг DTO → домен. Решения (что пушить, когда алертить,
  какой следующий интервал) принимают use cases / домен.
- `main.ts` — единственный composition root (ручной DI). Адаптер CRM выбирается `CRM_DRIVER=mock|ncrm`.
- Время только через `Clock` (`shared/clock.ts`), никаких `new Date()` / `Date.now()` в domain/application.
- Зависимости направлены внутрь: infrastructure → application → domain.

## Идемпотентность (обязательна для каждого джоба)
- Повторный запуск любого use case не создаёт дублей событий, уведомлений и апдейтов CRM.
- `TrackingEvent.dedupHash = sha256(track + rawStatus + occurredAt + location)` — unique.
- `NotificationOutbox.dedupKey` — unique (напр. `shipmentId:status`).
- CRM обновляется **только на переходе статуса**, не на каждом опросе — через `crmSyncStatus`
  (PENDING / SYNCED / FAILED, до 5 попыток).
- Терминальные статусы (DELIVERED, RETURNED) не опрашиваются.

## Outbox
Use case пишет уведомление в `notification_outbox` **в той же транзакции**, что и смену статуса.
Отправляет в Telegram только `DispatchNotifications` (ретраи до 5, учёт 429 `retry_after`).
Use cases никогда не вызывают `NotifierPort` напрямую при смене статуса.

## Надёжность
- Каждый джоб под Postgres advisory lock; `correlationId` на каждый прогон; pino JSON.
- Graceful shutdown по SIGTERM: стоп scheduler → ждать задачи до 25 с → закрыть Prisma.
- Telegram: по умолчанию long polling (`TELEGRAM_MODE=polling`, без домена); webhook — опционально. Отдельные сообщения о смене статуса — только для `TELEGRAM_NOTIFY_STATUSES` (по умолчанию `DELIVERED`); после опроса уходит одна сводка (`BuildDailyReport.enqueuePollSummary`) со списками «вручено» и «возвраты» именно этого прогона (сделка + трек). Команды: `/id`, `/start`, `/help` — всем, остальные — только `TELEGRAM_ADMIN_IDS`. Настройка: `docs/TELEGRAM_SETUP.md`.
- Опрос Казпочты — по расписанию `POLL_CRON` (**один раз в сутки, 08:00 Алматы**), запуск проверяет все активные посылки.
- **Возврат.** Любое событие возврата Казпочты (`RETURNING`/`RETURNED`) делает посылку `RETURNED` навсегда: последующее «вручено» (отправитель забрал свою посылку) доставкой не считается (`applyObservation`). `RETURNED` → CRM-этап «КЛИЕНТ НЕ ЗАБРАЛ ОТКАЗ» (`CRM_STATUS_MAP`), только пока сделка ещё в «НА ДОСТАВКЕ».
- `/health`: БД + время последнего успешного прогона джобов; 503 если poll не отрабатывал дольше `HEALTH_POLL_STALE_HOURS` (26 ч).
- Неизвестный статус Казпочты → `UNKNOWN` + `DEV_ALERT` с raw-текстом. Ответ, не прошедший
  мягкую zod-валидацию → `DEV_ALERT` и пропуск записи, батч не падает.
- Ответ «нет информации по треку» — пустая история, не ошибка.
- Секреты только через env, никогда в логах/коде. `.env` в `.gitignore`.

## Код
- TS `strict` + `noUncheckedIndexedAccess`; без `any`; внешние данные — через zod.
- Иммутабельность: не мутировать объекты, возвращать новые копии.
- Файлы < 800 строк, функции < 50 строк, ранние return вместо вложенности.
- Ошибки обрабатываются явно, не глотаются; доменные ошибки — в `domain/errors.ts`.
- Магические числа — именованные константы/конфиг.

## Тесты (vitest)
- Unit: `TrackCode`, `kazpost-status.mapper` (на фикстурах), переходы `Shipment`, фильтр «только Казпочта».
- Use cases: in-memory фейки портов + фиксированный `Clock`; идемпотентность, курьерские игнорируются,
  DELIVERED не опрашивается, outbox не дублирует.
- Integration: Prisma на тестовом Postgres (docker compose), Kazpost adapter на фикстурах без сети.
- После каждого шага: `pnpm typecheck && pnpm test`. Перед завершением ещё `pnpm lint`.

## Команды
`pnpm dev` · `pnpm build` · `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm test:integration` ·
`pnpm prisma:generate` · `pnpm prisma:migrate`

## Внешние API
Разбор официальных API Казпочты и NCRM — в `docs/API_NOTES.md` (читать перед правками адаптеров).
Статусы Казпочты — коды из справочника; таблица генерируется `node scripts/generate-kazpost-codes.mjs`, вручную не править.

## NCRM
`NcrmAdapter` проверен на живом аккаунте cloud.ncrm.pro: чтение сделок и комментариев, перенос этапа (`docs/API_NOTES.md`). Не проверена запись комментария (`CRM_ADD_COMMENT`).
Рабочий процесс: трек берётся из комментария сделки; отслеживаются только сделки этапа «НА ДОСТАВКЕ»
(`NCRM_SOURCE_STAGE_ID`); при `DELIVERED` сделка переносится в «УСПЕШНО ДОСТАВЛЕН» (`CRM_STATUS_MAP`), и только
пока она ещё в исходном этапе (`CrmPort.getOrderStatus` + `requiredCurrentStatus`). Детали — `docs/API_NOTES.md`.
ID полей/этапов: `pnpm ncrm:inspect` (с id сделки печатает форму ответов). Интерфейс `CrmPort` менять только осознанно — он зафиксирован в SPEC §8.2.
