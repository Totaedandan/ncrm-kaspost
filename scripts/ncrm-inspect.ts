// Prints the NCRM pipelines (stage ids for NCRM_SOURCE_STAGE_ID / CRM_STATUS_MAP) and custom fields (ids for
// NCRM_DELIVERY_FIELD_ID). Needs NCRM_BASE_URL and NCRM_API_KEY in the environment.
// With a deal id (`pnpm ncrm:inspect 7350332`) it also prints the *shape* (keys only, no customer data)
// of that deal and of its comments, to check the assumptions in docs/API_NOTES.md.
import process from 'node:process';
import { HttpClient } from '../src/infrastructure/http/http-client';
import { NcrmAdapter } from '../src/infrastructure/crm/ncrm.adapter';

const write = (text: string): void => void process.stdout.write(`${text}\n`);

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

async function main(): Promise<void> {
  const baseUrl = process.env.NCRM_BASE_URL ?? '';
  const apiKey = process.env.NCRM_API_KEY ?? '';
  if (baseUrl === '' || apiKey === '') {
    throw new Error('Set NCRM_BASE_URL and NCRM_API_KEY first.');
  }

  const crm = new NcrmAdapter({
    baseUrl,
    apiKey,
    trackFieldId: null,
    deliveryFieldId: null,
    http: new HttpClient({ service: 'ncrm', userAgent: 'ncrm-kazpost-inspect/0.1' }),
  });
  const { funnels, customFields } = await crm.describeSetup();

  write('=== Воронки и этапы (значения для CRM_STATUS_MAP) ===');
  for (const funnel of asArray(funnels)) {
    write(`Воронка ${String(funnel.id)}: ${String(funnel.funnel_name)}`);
    for (const stage of asArray(funnel.stages)) {
      write(`  этап id=${String(stage.id)}  ${String(stage.stage_name)}`);
    }
  }

  write('\n=== Пользовательские поля (NCRM_TRACK_FIELD_ID / NCRM_DELIVERY_FIELD_ID) ===');
  for (const field of asArray(customFields)) {
    const options = JSON.stringify(field.options ?? null);
    write(`  id=${String(field.id)}  entity=${String(field.entity)}  type=${String(field.field_type)}  ${String(field.field_name)}`);
    if (options !== 'null' && options !== '[]') write(`      варианты: ${options}`);
  }

  const dealId = process.argv[2];
  if (dealId !== undefined) await describeDeal(crm, dealId);
}

function keysOf(value: unknown): string {
  if (Array.isArray(value)) return `массив(${value.length})`;
  if (typeof value === 'object' && value !== null) return Object.keys(value).join(', ');
  return typeof value;
}

async function describeDeal(crm: NcrmAdapter, dealId: string): Promise<void> {
  const { deal, notes } = await crm.describeDeal(dealId);
  write(`\n=== Сделка ${dealId}: ключи ===\n  ${keysOf(deal)}`);
  const fieldValues = typeof deal === 'object' && deal !== null ? (deal as Record<string, unknown>)['field_values'] : null;
  if (Array.isArray(fieldValues)) write(`  field_values[0]: ${keysOf(fieldValues[0])}`);
  write(`\n=== Комментарии сделки ${dealId}: ${notes.length} шт. ===`);
  notes.slice(0, 3).forEach((note, index) => write(`  [${index}] ключи: ${keysOf(note)}`));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
