import { describe, expect, it } from 'vitest';
import { buildTraceDocument, type TraceSnapshot } from './document.js';

function snapshot(overrides: Partial<TraceSnapshot>): TraceSnapshot {
  return {
    userId: '00000000-0000-0000-0000-000000000001',
    bookId: '00000000-0000-0000-0000-000000000002',
    entityType: 'ANNOTATION',
    entityId: '00000000-0000-0000-0000-000000000003',
    sourceVersion: 1,
    pageStart: 12,
    pageEnd: 14,
    text: '关于存在主义的批注',
    sourceCreatedAt: new Date('2026-09-01T00:00:00.000Z'),
    deleted: false,
    ...overrides
  };
}

describe('buildTraceDocument', () => {
  it('builds a document plan with postings and term count', () => {
    const plan = buildTraceDocument(snapshot({}));
    expect(plan).not.toBeNull();
    expect(plan?.entityType).toBe('ANNOTATION');
    expect(plan?.pageStart).toBe(12);
    expect(plan?.pageEnd).toBe(14);
    expect(plan?.postings.length).toBeGreaterThan(0);
    const tfSum = plan?.postings.reduce((sum, posting) => sum + posting.tf, 0) ?? 0;
    expect(plan?.termCount).toBe(tfSum);
  });

  it('returns null for deleted snapshots', () => {
    expect(buildTraceDocument(snapshot({ deleted: true }))).toBeNull();
  });

  it('returns null for empty or separator-only text', () => {
    expect(buildTraceDocument(snapshot({ text: null }))).toBeNull();
    expect(buildTraceDocument(snapshot({ text: '   ' }))).toBeNull();
    expect(buildTraceDocument(snapshot({ text: '——…—' }))).toBeNull();
  });

  it('produces identical plans for identical snapshots (rebuild determinism)', () => {
    const first = buildTraceDocument(snapshot({}));
    const second = buildTraceDocument(snapshot({}));
    expect(first).toEqual(second);
  });
});
