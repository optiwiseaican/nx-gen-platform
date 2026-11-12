import { renderAuditPdf } from './audit-pdf';
import type { AuditEntry } from './audit.service';

const entry = (
  sequence: number,
  over: Partial<AuditEntry> = {},
): AuditEntry => ({
  sequence,
  eventId: `event-${sequence}`,
  occurredAt: '2026-11-09T07:03:05.123Z',
  category: 'SECURITY',
  action: 'LOGIN_FAILED',
  result: 'FAILURE',
  actor: 'user-1',
  actorName: 'Test User',
  tableName: 'users',
  recordId: 'user-1',
  oldValue: null,
  newValue: null,
  reason: null,
  machineName: null,
  ipAddress: null,
  platformInstanceId: null,
  errorCode: null,
  details: null,
  ...over,
});

const render = (entries: AuditEntry[]) =>
  renderAuditPdf(
    entries,
    {},
    {
      generatedBy: 'Test',
      generatedById: 'user-1',
      platformInstanceId: null,
      chain: { valid: true },
    },
  );

/** Page count from the PDF's (uncompressed) page tree. */
const pages = (pdf: Buffer) =>
  Number(/\/Type \/Pages\s+\/Count (\d+)/.exec(pdf.toString('latin1'))?.[1]);

describe('renderAuditPdf', () => {
  it('fits an empty extract on one page', async () => {
    expect(pages(await render([]))).toBe(1);
  });

  it('adds pages as entries grow', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => entry(i + 1));
    expect(pages(await render(rows))).toBeGreaterThan(3);
  });

  it('runs very long values across pages without adding blank ones', async () => {
    const newValue = { blob: 'x'.repeat(60_000) };
    const reason = 'long reason '.repeat(100);
    const count = pages(await render([entry(1, { newValue, reason })]));
    expect(count).toBeGreaterThan(1);
    expect(count).toBeLessThanOrEqual(6);
  });

  it('accepts characters outside the standard fonts', async () => {
    const pdf = await render([entry(1, { actorName: 'विशाल 陳 → €' })]);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
