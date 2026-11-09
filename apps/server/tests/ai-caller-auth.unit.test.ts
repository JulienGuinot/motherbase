import { describe, expect, it } from 'vitest';
import { callerAuthHeaders } from '../controllers/ai.controller';

/**
 * The assistant's tools call this server's own admin API carrying the caller's
 * credential. Which header that is depends on how the request arrived, and
 * getting it wrong is silent: the model simply reports that every tool failed.
 */
describe('callerAuthHeaders', () => {
  it('forwards a user bearer token in a standalone deployment', () => {
    expect(callerAuthHeaders({ authorization: 'Bearer abc' })).toEqual({ Authorization: 'Bearer abc' });
  });

  it('forwards the platform token behind the Console, which strips Authorization', () => {
    expect(callerAuthHeaders({ 'x-platform-token': 'plat' })).toEqual({ 'X-Platform-Token': 'plat' });
  });

  it('prefers the platform token when both are present', () => {
    // The proxy sets one and deletes the other, so both together means a client
    // supplied its own Authorization. The proxy's token is the trusted one.
    expect(callerAuthHeaders({ authorization: 'Bearer abc', 'x-platform-token': 'plat' })).toEqual({
      'X-Platform-Token': 'plat',
    });
  });

  it('sends no credential at all rather than an empty one', () => {
    // An empty `Bearer ` is a credential the server has to evaluate and reject.
    // Sending nothing fails the same way without pretending to authenticate.
    expect(callerAuthHeaders({})).toEqual({});
    expect(callerAuthHeaders({ authorization: '' })).toEqual({});
    expect(callerAuthHeaders({ 'x-platform-token': '' })).toEqual({});
    // A repeated header arrives as an array; that is not a token.
    expect(callerAuthHeaders({ 'x-platform-token': ['a', 'b'] })).toEqual({});
  });
});
