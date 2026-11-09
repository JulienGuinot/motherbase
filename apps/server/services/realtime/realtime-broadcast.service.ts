import { contractPath } from '@motherbase/contracts';
import BaseContext from '../../context/base-context';
import { rlsContextFor } from '../../lib/rls-claims';
import { quoteIdentStrict } from '../../lib/sql-identifier';
import type { SubscriberIdentityGroup } from '../socket.service';

export interface RealtimeModel {
  model: string;
  dbName: string;
}

export type DeleteRealtimeAudience =
  | { mode: 'disabled' }
  | { mode: 'all'; socketIds: Set<string> }
  | { mode: 'restricted'; socketIdsByRowId: Map<string, Set<string>> };

export type RealtimeAction = 'created' | 'updated' | 'deleted';

const quoteIdentifier = quoteIdentStrict;

/**
 * A socket that already got the `rt:msg` postgres_changes envelope for this row
 * must not also get the legacy flat `<model>:<action>` event: an app using both
 * `channel().on('postgres_changes')` and the deprecated `watchTable()` would
 * otherwise handle every change twice. Sockets with no matching topic binding
 * (watchTable-only clients) are untouched.
 */
function withoutTopicRecipients(socketIds: string[], viaTopic: Set<string> | undefined): string[] {
  if (!viaTopic?.size) return socketIds;
  return socketIds.filter(socketId => !viaTopic.has(socketId));
}

export class RealtimeBroadcastService extends BaseContext {
  /** Deliver sockets for a claimed outbox event before it is acknowledged. */
  async deliverPersisted(
    model: RealtimeModel,
    action: RealtimeAction,
    payloads: unknown[],
    deleteAudience?: DeleteRealtimeAudience
  ): Promise<void> {
    await this.deliver(model, action, payloads, deleteAudience, true);
  }

  async captureDeleteAudience(model: RealtimeModel, rowIds: unknown[]): Promise<DeleteRealtimeAudience> {
    const enabled = await this.di.RealtimeAdminService?.isModelEnabled?.(model.model);
    if (enabled === false) return { mode: 'disabled' };

    const groups = this.di.SocketService?.getSubscriberGroups?.(model.model) ?? [];
    if (!groups.length) return { mode: 'restricted', socketIdsByRowId: new Map() };

    const modelConfig = await this.di.RealtimeAdminService?.getModelConfig?.(model.model);
    if (modelConfig?.respectRls === false) {
      return { mode: 'all', socketIds: new Set(groups.flatMap(group => group.socketIds)) };
    }

    const visibleByIdentity = await this.visibleRowsByIdentity(model, rowIds, groups);
    const socketIdsByRowId = new Map<string, Set<string>>();
    for (const rowId of rowIds) {
      const key = String(rowId);
      const socketIds = new Set<string>();
      for (const group of groups) {
        if (visibleByIdentity.get(group.key)?.has(key)) {
          for (const socketId of group.socketIds) socketIds.add(socketId);
        }
      }
      socketIdsByRowId.set(key, socketIds);
    }
    return { mode: 'restricted', socketIdsByRowId };
  }

  private async deliver(
    model: RealtimeModel,
    action: RealtimeAction,
    payloads: unknown[],
    deleteAudience?: DeleteRealtimeAudience,
    strictRls = false
  ): Promise<void> {
    if (action === 'deleted') {
      if (!deleteAudience || deleteAudience.mode === 'disabled') return;
      this.deliverDeletes(model, payloads, deleteAudience);
      return;
    }

    const enabled = await this.di.RealtimeAdminService?.isModelEnabled?.(model.model);
    if (enabled === false) return;

    const groups = this.di.SocketService?.getSubscriberGroups?.(model.model) ?? [];
    if (!groups.length) return;

    const modelConfig = await this.di.RealtimeAdminService?.getModelConfig?.(model.model);
    const respectRls = modelConfig?.respectRls !== false;
    const visibleByIdentity = respectRls
      ? await this.visibleRowsByIdentity(
          model,
          payloads.map(payload => (payload as any)?.id).filter(id => id != null),
          groups,
          strictRls
        )
      : null;
    const event = contractPath.realtime(model.model, action);

    for (const payload of payloads) {
      const rowId = (payload as any)?.id;
      if (respectRls && rowId == null) continue;
      for (const group of groups) {
        if (visibleByIdentity && !visibleByIdentity.get(group.key)?.has(String(rowId))) continue;
        const viaTopic = this.di.RealtimePostgresService?.fanToTopics?.(group.socketIds, model, action, payload);
        this.di.SocketService?.emitToSocketIds?.(withoutTopicRecipients(group.socketIds, viaTopic), event, payload);
      }
    }
  }

  private deliverDeletes(
    model: RealtimeModel,
    payloads: unknown[],
    audience: Exclude<DeleteRealtimeAudience, { mode: 'disabled' }>
  ): void {
    const currentSubscribers = this.di.SocketService?.getSubscriberSocketIds?.(model.model) ?? new Set<string>();
    if (!currentSubscribers.size) return;
    const event = contractPath.realtime(model.model, 'deleted');

    for (const payload of payloads) {
      const captured =
        audience.mode === 'all' ? audience.socketIds : audience.socketIdsByRowId.get(String((payload as any)?.id));
      if (!captured?.size) continue;
      const recipients = Array.from(captured).filter(socketId => currentSubscribers.has(socketId));
      const viaTopic = this.di.RealtimePostgresService?.fanToTopics?.(recipients, model, 'deleted', payload);
      this.di.SocketService?.emitToSocketIds?.(withoutTopicRecipients(recipients, viaTopic), event, payload);
    }
  }

  private async visibleRowsByIdentity(
    model: RealtimeModel,
    rowIds: unknown[],
    groups: SubscriberIdentityGroup[],
    strict = false
  ): Promise<Map<string, Set<string>>> {
    const uniqueIds = Array.from(new Map(rowIds.map(id => [String(id), id])).values());
    const results = await Promise.all(
      groups.map(async group => [group.key, await this.visibleRows(model, uniqueIds, group.user, strict)] as const)
    );
    return new Map(results);
  }

  private async visibleRows(
    model: RealtimeModel,
    rowIds: unknown[],
    user: SubscriberIdentityGroup['user'],
    strict = false
  ): Promise<Set<string>> {
    if (!rowIds.length) return new Set();
    try {
      return await this.di.RlsPool.withRlsTx(rlsContextFor(user), async client => {
        const result = await client.query(`SELECT "id" FROM ${quoteIdentifier(model.dbName)} WHERE "id" = ANY($1)`, [
          rowIds,
        ]);
        return new Set<string>(result.rows.map((row: { id: unknown }) => String(row.id)));
      });
    } catch (error) {
      if (strict) throw error;
      return new Set();
    }
  }
}
