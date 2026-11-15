import { describe, expect, it } from 'vitest';
import { PROJECT_SERVICES, runningServices } from './project-services';

describe('runningServices', () => {
  it('leaves the edge runtime out, and only it, when it is turned off', () => {
    expect(runningServices(true)).toEqual(PROJECT_SERVICES);
    expect(runningServices(false).map(s => s.service)).toEqual(['api', 'db', 'minio']);
  });
});
