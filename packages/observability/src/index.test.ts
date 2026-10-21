import { describe, expect, it } from 'vitest';

import * as mod from './index';

describe('@erp/observability', () => {
  it('loads', () => {
    expect(mod).toBeTypeOf('object');
  });
});
