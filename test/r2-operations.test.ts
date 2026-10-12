import { describe, expect, it } from 'vitest';
import { classifyR2Action } from '../src/modules/platform-stats/r2-operations.ts';

describe('classifyR2Action', () => {
  it('classifies read-like actions as Class B', () => {
    expect(classifyR2Action('GetObject')).toBe('classB');
    expect(classifyR2Action('HeadObject')).toBe('classB');
    expect(classifyR2Action('UsageSummary')).toBe('classB');
  });

  it('classifies write-like actions as Class A', () => {
    expect(classifyR2Action('PutObject')).toBe('classA');
    expect(classifyR2Action('ListObjects')).toBe('classA');
    expect(classifyR2Action('CreateMultipartUpload')).toBe('classA');
    expect(classifyR2Action('UploadPart')).toBe('classA');
  });

  it('classifies deletes and aborts as free — neither class', () => {
    expect(classifyR2Action('DeleteObject')).toBe('free');
    expect(classifyR2Action('DeleteBucket')).toBe('free');
    expect(classifyR2Action('AbortMultipartUpload')).toBe('free');
  });

  it('falls back to Class A — the cheaper-to-exhaust, conservative choice — for an unknown action type', () => {
    expect(classifyR2Action('SomeActionCloudflareAddsLater')).toBe('classA');
  });
});
