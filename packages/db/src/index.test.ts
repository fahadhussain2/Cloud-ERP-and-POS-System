import { describe, expect, it } from 'vitest';

import * as mod from './index';

describe('@erp/db', () => {
  it('loads', () => {
    expect(mod).toBeTypeOf('object');
  });
});
