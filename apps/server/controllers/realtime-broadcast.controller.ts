import { before, POST, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { HTTP_ROUTES, isValidRealtimeTopic } from '@motherbase/contracts';
import IContextContainer from '../context/icontext-container';
import * as apiResponse from '../helpers/api-response.helper';
import { optionalAuthMiddleware } from '../middlewares/auth.middleware';
import { apiKeyMiddleware, callerFor } from '../middlewares/api-key.middleware';
import { HttpException } from '../exceptions/http-exception';
// Same ceiling the socket relay applies, so an event name accepted on one path
// is accepted on the other.
import { MAX_EVENT_LENGTH } from '../services/realtime/realtime-topic.service';

/** One request is a batch, not a firehose: the body is already capped at 100kb
 *  by express.json, this bounds the fan-out work that batch can ask for. */
const MAX_MESSAGES = 100;

interface BroadcastMessageInput {
  topic?: unknown;
  event?: unknown;
  payload?: unknown;
  private?: unknown;
}

@route(HTTP_ROUTES.realtimeBroadcast)
export default class RealtimeBroadcastController {
  constructor(private di: IContextContainer) {}

  /**
   * Server-side broadcast to channel topics: { messages: [{ topic, event, payload, private? }] }.
   *
   * A `private` message goes to the private channel of its topic and needs
   * the caller to pass the channel's broadcast INSERT policy, the same check
   * a socket sending on that channel passes (a secret key is service_role and
   * passes it). The decision is made once per topic per request.
   */
  @POST()
  @before([optionalAuthMiddleware, apiKeyMiddleware])
  async broadcast(req: Request, res: Response, next: NextFunction) {
    try {
      const body = req.body as { messages?: unknown } | undefined;
      const messages: BroadcastMessageInput[] = Array.isArray(body?.messages) ? body.messages : [];
      if (messages.length > MAX_MESSAGES) {
        throw new HttpException(`At most ${MAX_MESSAGES} messages per request.`, 400);
      }
      let delivered = 0;
      const canSend = new Map<string, Promise<boolean>>();
      const mayBroadcastPrivately = (topic: string) => {
        if (!canSend.has(topic)) {
          canSend.set(
            topic,
            this.di.RealtimeAuthorizationService.channelAccess(callerFor(req) ?? null, topic).then(a => a.broadcast.write)
          );
        }
        return canSend.get(topic)!;
      };
      for (const message of messages) {
        if (!isValidRealtimeTopic(message?.topic)) continue;
        const event = String(message.event ?? '');
        // The event name ends up in every subscriber's handler and in the logs;
        // the topic is already length-checked, so this is the last unbounded
        // string on the path.
        if (event.length > MAX_EVENT_LENGTH) {
          throw new HttpException(`event must be at most ${MAX_EVENT_LENGTH} characters.`, 400);
        }
        const isPrivate = message.private === true;
        if (isPrivate && !(await mayBroadcastPrivately(message.topic))) {
          throw new HttpException(`Unauthorized: You do not have permissions to write to this Channel topic: ${message.topic}`, 403);
        }
        delivered += this.di.SocketService.broadcastToTopic(message.topic, event, message.payload ?? {}, isPrivate);
      }
      return apiResponse.successResponseWithData(res, 'OK', { delivered });
    } catch (error: unknown) {
      return next(error);
    }
  }
}
