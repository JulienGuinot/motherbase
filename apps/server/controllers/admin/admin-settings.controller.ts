import { before, GET, POST, PATCH, PUT, DELETE, route } from 'awilix-express';
import { NextFunction, Request, Response } from 'express';
import IContextContainer from '../../context/icontext-container';
import { adminOnly } from '../../middlewares/platform-admin.middleware';
import * as apiResponse from '../../helpers/api-response.helper';
import { HttpException } from '../../exceptions/http-exception';
import { applyRateLimitLimits } from '../../middlewares/rate-limit';
import { applyRateLimitRules } from '../../middlewares/custom-rate-limit';
import { applyCaptchaConfig } from '../../middlewares/captcha-guard';
import { SYSTEM_EVENTS } from '../../services/events/event-dispatcher.service';


@route('/api/admin')
export default class AdminSettingsController {
  constructor(private di: IContextContainer) {}

  private async applySettingsSideEffects(group: string): Promise<void> {
    // AuthManager derives Better Auth's providers, plugins and trusted origins
    // from settings, so those groups need a live rebuild after every mutation.
    if (group.startsWith('auth.') || group === 'server.cors' || group === 'phone.sms') {
      this.di.AuthManager.reload();
    }
    if (group === 'security.rateLimit') {
      applyRateLimitLimits(await this.di.SettingsService.get('security.rateLimit'));
    }
    if (group === 'auth.attackProtection') {
      applyCaptchaConfig(await this.di.SettingsService.get('auth.attackProtection'));
    }
    if (group === 'security.rateLimitRules') {
      applyRateLimitRules(await this.di.SettingsService.get('security.rateLimitRules'));
    }
    if (group === 'data.retention' || group === 'logs.retention') {
      await this.di.DataRetentionSchedulerService.reschedule();
    }
    if (group === 'logs.retention') {
      // The buffer listener decides synchronously whether to keep a line, so
      // it reads a cached flag that has to be refreshed when it changes.
      await this.di.LogPersistenceService.reload();
    }
    if (group === 'backup.schedule') {
      await this.di.BackupSchedulerService.reschedule();
    }
  }

  // The events a webhook can subscribe to that are not row changes. Served so the
  // picker cannot drift from what the dispatcher actually publishes.
  @GET()
  @route('/webhooks/events')
  @before(adminOnly)
  async listWebhookEvents(_req: Request, res: Response) {
    return apiResponse.successResponseWithData(res, 'OK', { events: SYSTEM_EVENTS });
  }

  @GET()
  @route('/webhooks')
  @before(adminOnly)
  async webhooks(_req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', { webhooks: await this.di.WebhookAdminService.list() });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/webhooks')
  @before(adminOnly)
  async createWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'Created', await this.di.WebhookAdminService.create(req.body));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PATCH()
  @route('/webhooks/:id')
  @before(adminOnly)
  async updateWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(
        res,
        'Updated',
        await this.di.WebhookAdminService.update(req.params.id, req.body ?? {})
      );
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/webhooks/:id')
  @before(adminOnly)
  async deleteWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      await this.di.WebhookAdminService.delete(req.params.id);
      return apiResponse.successResponse(res, 'Deleted');
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/webhooks/:id/test')
  @before(adminOnly)
  async testWebhook(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.WebhookAdminService.sendTest(req.params.id));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/webhooks/:id/rotate-secret')
  @before(adminOnly)
  async rotateWebhookSecret(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.WebhookAdminService.rotateSecret(req.params.id));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/webhooks/:id/deliveries')
  @before(adminOnly)
  async webhookDeliveries(req: Request, res: Response, next: NextFunction) {
    try {
      const deliveries = await this.di.WebhookAdminService.deliveries(req.params.id);
      return apiResponse.successResponseWithData(res, 'OK', { deliveries });
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/settings')
  @before(adminOnly)
  async settingsList(_req: Request, res: Response) {
    const { listGroups } = await import('../../config/settings');
    const groups = await Promise.all(
      listGroups().map(async g => ({ ...g, source: await this.di.SettingsService.source(g.key) }))
    );
    return apiResponse.successResponseWithData(res, 'OK', { groups });
  }

  @GET()
  @route('/settings/:group')
  @before(adminOnly)
  async settingsGet(req: Request, res: Response, next: NextFunction) {
    try {
      return apiResponse.successResponseWithData(res, 'OK', await this.di.SettingsService.getMasked(req.params.group));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @PUT()
  @route('/settings/:group')
  @before(adminOnly)
  async settingsPut(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req.user as any)?.id;
      const updated = await this.di.SettingsService.set(req.params.group, req.body ?? {}, userId);
      await this.applySettingsSideEffects(req.params.group);
      return apiResponse.successResponseWithData(res, 'Saved', updated);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @DELETE()
  @route('/settings/:group')
  @before(adminOnly)
  async settingsDelete(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req.user as any)?.id;
      const reset = await this.di.SettingsService.reset(req.params.group, userId);
      await this.applySettingsSideEffects(req.params.group);
      return apiResponse.successResponseWithData(res, 'Reset', reset);
    } catch (error: unknown) {
      return next(error);
    }
  }

  @GET()
  @route('/auth/status')
  @before(adminOnly)
  async authStatus(_req: Request, res: Response) {
    return apiResponse.successResponseWithData(res, 'OK', { items: await this.di.AuthManager.status() });
  }

  @POST()
  @route('/settings/email/test')
  @before(adminOnly)
  async settingsEmailTest(req: Request, res: Response, next: NextFunction) {
    try {
      const to = req.body?.to;
      if (!to) throw new HttpException('A "to" address is required.', 400);
      return apiResponse.successResponseWithData(res, 'Sent', await this.di.TransporterService.sendTestEmail(to));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/settings/sms/test')
  @before(adminOnly)
  async settingsSmsTest(req: Request, res: Response, next: NextFunction) {
    try {
      const to = req.body?.to;
      if (!to) throw new HttpException('A "to" phone number is required.', 400);
      return apiResponse.successResponseWithData(res, 'Sent', await this.di.SmsService.sendTestSms(to));
    } catch (error: unknown) {
      return next(error);
    }
  }

  @POST()
  @route('/settings/push/test')
  @before(adminOnly)
  async settingsPushTest(req: Request, res: Response, next: NextFunction) {
    try {
      const { token, platform } = req.body ?? {};
      if (!token) throw new HttpException('A device token is required.', 400);
      if (platform !== 'ios' && platform !== 'android' && platform !== 'web') {
        throw new HttpException('platform must be "ios", "android" or "web".', 400);
      }
      const result = await this.di.NotificationService.sendToToken(token, platform, {
        title: 'Test notification',
        body: 'Push delivery is configured correctly.',
      });
      return apiResponse.successResponseWithData(res, 'Sent', result);
    } catch (error: unknown) {
      return next(error);
    }
  }
}
