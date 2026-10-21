import { describe, expect, it } from 'vitest';

import * as mod from './index';

describe('@erp/ui', () => {
  it('loads', () => {
    expect(mod).toBeTypeOf('object');
  });
});
