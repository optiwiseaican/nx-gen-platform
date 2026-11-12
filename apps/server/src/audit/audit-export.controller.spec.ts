import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { AuditController } from '../auth/auth.controller';
import { PlatformIdentityService } from '../platform/platform-identity.service';
import { AUDIT_PDF_MAX_ROWS, AuditService } from './audit.service';

describe('GET /audit/export', () => {
  let app: INestApplication;
  const pdf = Buffer.from('%PDF-1.3 binary \xff\x00 bytes', 'latin1');
  const summary = {
    rows: 2,
    sha256: 'a'.repeat(64),
    firstSequence: 1,
    lastSequence: 2,
    truncated: false,
  };
  const audit = {
    verifyChain: jest.fn().mockResolvedValue({ valid: true }),
    countMatching: jest.fn(),
    exportPdf: jest.fn().mockResolvedValue({ ...summary, pdf }),
    exportCsv: jest.fn().mockResolvedValue({ ...summary, csv: 'a,b\r\n' }),
    record: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [
        { provide: AuditService, useValue: audit },
        {
          provide: PlatformIdentityService,
          useValue: { getIdentity: () => ({ identity: null }) },
        },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { principal: unknown }).principal = {
        userId: 'u-1',
        fullName: 'Test User',
      };
      next();
    });
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => {
    audit.record.mockClear();
    audit.exportPdf.mockClear();
    audit.countMatching.mockResolvedValue(2);
  });

  it('sends the PDF bytes unchanged and records the export', async () => {
    const res = await request(app.getHttpServer() as never)
      .get('/audit/export?format=pdf')
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/\.pdf"$/);
    expect(res.headers['x-nxgen-export-sha256']).toBe(summary.sha256);
    expect(res.body).toEqual(pdf);
    const [event] = audit.record.mock.calls[0] as [unknown];
    expect(event).toMatchObject({
      action: 'AUDIT_TRAIL_EXPORTED',
      details: { format: 'PDF', sha256: summary.sha256 },
    });
  });

  it('refuses a PDF over the limit instead of cutting it short', async () => {
    audit.countMatching.mockResolvedValue(AUDIT_PDF_MAX_ROWS + 1);
    await request(app.getHttpServer() as never)
      .get('/audit/export?format=pdf')
      .expect(400);
    expect(audit.exportPdf).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('still defaults to CSV and rejects unknown formats', async () => {
    const csv = await request(app.getHttpServer() as never)
      .get('/audit/export')
      .expect(200);
    expect(csv.text).toBe('a,b\r\n');
    await request(app.getHttpServer() as never)
      .get('/audit/export?format=xlsx')
      .expect(400);
  });
});
