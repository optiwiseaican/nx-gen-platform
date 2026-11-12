import PDFDocument from 'pdfkit';
import type { ReportInput, ReportSection } from '@crescent/module-sdk';

const MARGIN = 36;
const HEADER_HEIGHT = 22;
const FOOTER_HEIGHT = 18;
const CELL_PADDING = 4;
/** Longer values move to full-width lines under the row, so a row always fits on a page. */
const MAX_CELL_CHARS = 200;
const INK = '#0f1b33';
const MUTED = '#5b6780';
const LINE = '#d9dfea';
const FAIL = '#b42318';
const HEADER_FILL = '#eef1f7';

/**
 * The PDF standard fonts only cover Windows-1252. Anything else is written as
 * its code point, because silently dropping characters would alter the record.
 */
export function printable(text: string): string {
  return text.replace(
    /[^\t\n\r\x20-\x7e\xa0-\xff€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/gu,
    (c) =>
      `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`,
  );
}

/**
 * Tabular report for printing and filing (Annex 11 §8.1). Every page repeats
 * the headings of the table it continues and carries "Page x of y", so a
 * missing page is evident; a banner, when given, is on every page.
 */
export function renderReport(input: ReportInput): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    layout: input.layout ?? 'landscape',
    bufferPages: true,
    margins: {
      top: MARGIN + HEADER_HEIGHT,
      bottom: MARGIN + FOOTER_HEIGHT,
      left: MARGIN,
      right: MARGIN,
    },
    info: { Title: printable(input.title), Author: 'NxGen' },
  });
  const done = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const contentWidth = doc.page.width - 2 * MARGIN;
  const widthsOf = (s: ReportSection) => {
    const total = s.columns.reduce((a, c) => a + c.weight, 0);
    return s.columns.map((c) => (c.weight / total) * contentWidth);
  };

  // The table a page continues, recorded as pages appear; drawn once all exist.
  let current: ReportSection | null = null;
  const pageSections: (ReportSection | null)[] = [null];
  doc.on('pageAdded', () => pageSections.push(current));

  const drawHeader = (s: ReportSection, y: number) => {
    const widths = widthsOf(s);
    doc.rect(MARGIN, y, contentWidth, HEADER_HEIGHT - 4).fill(HEADER_FILL);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
    let x = MARGIN;
    s.columns.forEach((c, i) => {
      doc.text(printable(c.title), x + CELL_PADDING, y + 5, {
        width: widths[i] - 2 * CELL_PADDING,
        lineBreak: false,
      });
      x += widths[i];
    });
  };

  doc.y = MARGIN;
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK);
  doc.text(printable(input.title), MARGIN, MARGIN);
  doc.moveDown(0.4);
  for (const { label, value, alert } of input.summary) {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED);
    doc.text(printable(label), MARGIN, y, { width: 110 });
    doc.font('Helvetica').fillColor(alert ? FAIL : INK);
    doc.text(printable(value), MARGIN + 110, y, {
      width: contentWidth - 110,
    });
  }
  if (input.note) {
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    doc.text(printable(input.note), MARGIN, doc.y, { width: contentWidth });
  }
  doc.moveDown(0.8);

  for (const section of input.sections) {
    current = null;
    const needed = (section.heading ? 22 : 0) + HEADER_HEIGHT + 30;
    if (doc.y + needed > bottom()) doc.addPage();
    if (section.heading) {
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK);
      doc.text(printable(section.heading), MARGIN, doc.y);
      doc.moveDown(0.3);
    }
    const headerY = doc.y;
    drawHeader(section, headerY);
    doc.y = headerY + HEADER_HEIGHT;
    current = section;
    const widths = widthsOf(section);

    if (section.rows.length === 0 && section.empty) {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED);
      doc.text(printable(section.empty), MARGIN, doc.y);
    }

    for (const row of section.rows) {
      const below: string[] = [];
      const cells = row.cells.map(printable).map((text, i) => {
        if (text.length <= MAX_CELL_CHARS) return text;
        below.push(`${printable(section.columns[i].title)}: ${text}`);
        return '(see below)';
      });
      below.push(...(row.below ?? []).map(printable));

      doc.font('Helvetica').fontSize(8);
      const rowHeight =
        Math.max(
          ...cells.map((text, i) =>
            doc.heightOfString(text, {
              width: widths[i] - 2 * CELL_PADDING,
            }),
          ),
        ) +
        2 * CELL_PADDING;
      // Keep the row with at least the first line of its details.
      if (doc.y + rowHeight + (below.length ? 12 : 0) > bottom()) doc.addPage();

      const top = doc.y;
      let x = MARGIN;
      cells.forEach((text, i) => {
        doc.fillColor(i === row.alertCell ? FAIL : INK);
        doc.text(text, x + CELL_PADDING, top + CELL_PADDING, {
          width: widths[i] - 2 * CELL_PADDING,
        });
        x += widths[i];
      });
      doc.y = top + rowHeight;

      if (below.length) {
        // May run across pages; pdfkit continues the text at the same indent.
        doc.fontSize(7).fillColor(MUTED);
        const indent = MARGIN + widths[0] + CELL_PADDING;
        doc.text(below.join('\n'), indent, doc.y, {
          width: contentWidth - widths[0] - 2 * CELL_PADDING,
        });
        doc.y += CELL_PADDING;
      }
      doc
        .moveTo(MARGIN, doc.y)
        .lineTo(MARGIN + contentWidth, doc.y)
        .lineWidth(0.5)
        .strokeColor(LINE)
        .stroke();
    }
    current = null;
    doc.moveDown(1);
  }

  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i++) {
    doc.switchToPage(i);
    const continued = pageSections[i - start];
    if (continued) drawHeader(continued, MARGIN);
    if (input.banner) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(FAIL);
      doc.text(printable(input.banner), MARGIN, 20, {
        width: contentWidth,
        align: 'center',
        lineBreak: false,
      });
    }
    // Writing inside the bottom margin would otherwise start a new page.
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    doc.text(
      `${printable(input.title)}   ·   Page ${i - start + 1} of ${count}`,
      MARGIN,
      doc.page.height - MARGIN - 8,
      { width: contentWidth, align: 'right', lineBreak: false },
    );
  }
  doc.end();
  return done;
}
