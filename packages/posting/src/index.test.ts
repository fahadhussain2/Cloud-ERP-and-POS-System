import { describe, expect, it } from 'vitest';

import * as mod from './index';

describe('@erp/posting', () => {
  it('loads', () => {
    expect(mod).toBeTypeOf('object');
  });
});
