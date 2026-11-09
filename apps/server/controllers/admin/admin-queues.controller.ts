import { before, DELETE, GET, POST, PUT, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { parseBody } from '../../lib/zod-body';
import { QUEUE_TYPES } from '../../services/admin/queue.service';

const createQueueSchema = z.object({
  name: z.string(),
  type: z.enum(QUEUE_TYPES).default('basic'),
  rls: z.boolean().default(true),
});

const exposeSchema = z.object({ enabled: z.boolean() });

// `message` is any JSON value: pgmq stores jsonb, and a bare string or number is
// as valid a payload as an object.
const sendSchema = z.object({
  message: z.unknown().refine(value => value !== undefined, 'is required'),
  delay: z.number().int().min(0).default(0),
});

const readSchema = z.object({
  vt: z.number().int().min(0).default(30),
  qty: z.number().int().min(1).max(100).default(1),
});

const browseSchema = z.object({
  archived: z.enum(['true', 'false']).optional().transform(value => value === 'true'),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const privilegesSchema = z.object({
  select: z.boolean(),
  insert: z.boolean(),
  update: z.boolean(),
  delete: z.boolean(),
});

const permissionsSchema = z.object({
  rlsEnabled: z.boolean().optional(),
  roles: z.object({ anon: privilegesSchema.optional(), authenticated: privilegesSchema.optional() }).optional(),
});

const msgIdSchema = z.coerce.number().int().positive();

/** Supabase Queues (pgmq). See QueueService for the model. */
@route('/api/admin')
export default class AdminQueuesController {
  constructor(private di: IContextContainer) {}

  @GET()
  @route('/queues')
  @before(adminOnly)
  async listQueues(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.QueueService.list());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/queues/enable')
  @before(adminOnly)
  async enableQueues(_req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.QueueService.enable();
      return apiResponse.successResponseWithData(res, 'Enabled', await this.di.QueueService.status());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PUT()
  @route('/queues/expose')
  @before(adminOnly)
  async exposeQueues(req: Request, res: Response, next: NextFunction) {
    try {
      const { enabled } = parseBody(exposeSchema, req.body);
      await this.di.QueueService.setExposed(enabled);
      return apiResponse.successResponseWithData(res, 'Updated', await this.di.QueueService.status());
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/queues')
  @before(adminOnly)
  async createQueue(req: Request, res: Response, next: NextFunction) {
    try {
      const queue = await this.di.QueueService.create(parseBody(createQueueSchema, req.body));
      return apiResponse.successResponseWithData(res, 'Created', { queue });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/queues/:name')
  @before(adminOnly)
  async dropQueue(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.QueueService.drop(req.params.name);
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/queues/:name/purge')
  @before(adminOnly)
  async purgeQueue(req: Request, res: Response, next: NextFunction) {
    try {
      const purged = await this.di.QueueService.purge(req.params.name);
      return apiResponse.successResponseWithData(res, 'Purged', { purged });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/queues/:name/messages')
  @before(adminOnly)
  async browseMessages(req: Request, res: Response, next: NextFunction) {
    try {
      const options = parseBody(browseSchema, req.query);
      return apiResponse.successResponseWithData(
        res,
        'OK',
        await this.di.QueueService.messages(req.params.name, options),
      );
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/queues/:name/messages')
  @before(adminOnly)
  async sendMessage(req: Request, res: Response, next: NextFunction) {
    try {
      const { message, delay } = parseBody(sendSchema, req.body);
      const msgIds = await this.di.QueueService.send(req.params.name, message, delay);
      return apiResponse.successResponseWithData(res, 'Sent', { msgIds });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/queues/:name/read')
  @before(adminOnly)
  async readMessages(req: Request, res: Response, next: NextFunction) {
    try {
      const { vt, qty } = parseBody(readSchema, req.body);
      const messages = await this.di.QueueService.read(req.params.name, vt, qty);
      return apiResponse.successResponseWithData(res, 'OK', { messages });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/queues/:name/messages/:msgId/archive')
  @before(adminOnly)
  async archiveMessage(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.QueueService.archive(req.params.name, parseBody(msgIdSchema, req.params.msgId));
      return apiResponse.successResponse(res, 'Archived');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/queues/:name/messages/:msgId')
  @before(adminOnly)
  async deleteMessage(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.QueueService.deleteMessage(req.params.name, parseBody(msgIdSchema, req.params.msgId));
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/queues/:name/permissions')
  @before(adminOnly)
  async queuePermissions(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.QueueService.permissions(req.params.name));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PUT()
  @route('/queues/:name/permissions')
  @before(adminOnly)
  async setQueuePermissions(req: Request, res: Response, next: NextFunction) {
    try {
      const patch = parseBody(permissionsSchema, req.body);
      return apiResponse.successResponseWithData(
        res,
        'Updated',
        await this.di.QueueService.setPermissions(req.params.name, patch),
      );
    } catch (error: unknown) {
      return next(error);
    }
  }
}
