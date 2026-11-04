// Read-only. Lists the deals of the source stage ("НА ДОСТАВКЕ") the service would track, with the
// current Kazpost status of each track, so a small pilot set can be picked by hand.
// Needs the NCRM_* settings in .env. Prints customer names: run it only on your own machine.
import process from 'node:process';
import { loadEnv } from '../src/config/env';
import { decideKazpostOrder } from '../src/domain/kazpost-filter';
import { pickLatestEvent } from '../src/domain/tracking-event';
import { NcrmAdapter } from '../src/infrastructure/crm/ncrm.adapter';
import { HttpClient } from '../src/infrastructure/http/http-client';
import { KazpostAdapter } from '../src/infrastructure/tracking/kazpost.adapter';
import { createLimiter, createRateGate } from '../src/shared/concurrency';

const write = (text: string): void => void process.stdout.write(`${text}\n`);
const USER_AGENT = 'ncrm-kazpost-pilot/0.1';
const MAX_PAGES = 100;

interface DealLabel {
  name: string;
  manager: string;
}

/** Deal name and responsible manager for every deal of the stage (the list endpoint carries both). */
async function fetchLabels(origin: string, token: string, stage: string, http: HttpClient): Promise<Map<string, DealLabel>> {
  const labels = new Map<string, DealLabel>();
  let url: string | null = `${origin}/api/deals/?${new URLSearchParams({ api_token: token, stage })}`;
  for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
    const response = await http.request(url, { headers: { referer: `${origin}/` } });
    const body = JSON.parse(response.text) as { results?: unknown[]; next?: string | null };
    for (const item of body.results ?? []) {
      const deal = item as { id?: number; full_name?: string; responsible?: string };
      if (deal.id !== undefined) labels.set(String(deal.id), { name: deal.full_name ?? '', manager: deal.responsible ?? '' });
    }
    url = body.next && new URL(body.next).origin === origin ? body.next : null;
  }
  return labels;
}

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.NCRM_BASE_URL === '' || env.NCRM_API_KEY === '' || env.NCRM_SOURCE_STAGE_ID === null) {
    throw new Error('Set NCRM_BASE_URL, NCRM_API_KEY and NCRM_SOURCE_STAGE_ID in .env first.');
  }
  const ncrmHttp = new HttpClient({ service: 'ncrm', userAgent: USER_AGENT });
  const stage = String(env.NCRM_SOURCE_STAGE_ID);
  const crm = new NcrmAdapter({
    baseUrl: env.NCRM_BASE_URL,
    apiKey: env.NCRM_API_KEY,
    trackFieldId: null,
    trackCommentPattern: env.TRACK_CODE_REGEX,
    deliveryFieldId: env.NCRM_DELIVERY_FIELD_ID,
    sourceStageId: stage,
    http: ncrmHttp,
  });
  const kazpost = new KazpostAdapter({ baseUrl: env.KAZPOST_BASE_URL, http: new HttpClient({ service: 'kazpost', userAgent: USER_AGENT }) });
  const filter = { deliveryValue: env.NCRM_KAZPOST_DELIVERY_VALUE, trackPattern: env.TRACK_CODE_REGEX };

  const origin = new URL(/^https?:\/\//i.test(env.NCRM_BASE_URL) ? env.NCRM_BASE_URL : `https://${env.NCRM_BASE_URL}`).origin;
  const labels = await fetchLabels(origin, env.NCRM_API_KEY, stage, ncrmHttp);

  const skipped: Record<string, number> = {};
  const tracked: Array<{ id: string; track: string; customer: string }> = [];
  let seen = 0;
  for await (const page of crm.listOrdersUpdatedSince(null)) {
    for (const order of page.orders) {
      seen += 1;
      const decision = decideKazpostOrder(order, filter);
      if (decision.kind === 'skip') {
        skipped[decision.reason] = (skipped[decision.reason] ?? 0) + 1;
      } else {
        tracked.push({ id: order.id, track: decision.trackCode.value, customer: order.customerName ?? '' });
      }
    }
  }
  write(`Сделок в колонке: ${seen}. С треком Казпочты: ${tracked.length}. Пропущено: ${JSON.stringify(skipped)}`);

  const limit = createLimiter(env.KAZPOST_CONCURRENCY);
  const gate = createRateGate(env.KAZPOST_MIN_INTERVAL_MS);
  const rows = await Promise.all(
    tracked.map((deal) =>
      limit(async () => {
        await gate();
        const events = await kazpost.fetchEvents(deal.track).catch(() => null);
        const latest = events === null ? null : pickLatestEvent(events);
        const status = events === null ? 'ошибка запроса' : latest === null ? 'нет данных' : `${latest.status} (${latest.rawStatus})`;
        return { ...deal, status, at: latest?.occurredAt.toISOString().slice(0, 10) ?? '' };
      }),
    ),
  );

  write('\nid | ссылка | клиент (контакт) | название сделки | менеджер | трек | статус Казпочты | дата события');
  for (const row of rows) {
    const label = labels.get(row.id);
    write([row.id, `${origin}/deals/info/${row.id}`, row.customer, label?.name ?? '', label?.manager ?? '', row.track, row.status, row.at].join(' | '));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
