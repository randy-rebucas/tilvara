import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  createApiKeySchema,
  createWebhookSchema,
  idParamSchema,
  updateWebhookSchema,
  type CreateApiKeyInput,
  type CreateWebhookInput,
  type UpdateWebhookInput,
} from '@1pos/validation';
import { AllowReadOnlyBusiness, Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { IntegrationsService } from './integrations.service.js';

const id = new ZodPipe(idParamSchema);

/** API keys and webhooks (ADR-0019); `integrations.manage` and the `api_access` plan feature, checked in the service. */
@RequireTenant()
@Controller()
export class IntegrationsController {
  constructor(@Inject(IntegrationsService) private readonly integrations: IntegrationsService) {}

  @Get('api-keys')
  listKeys(@Auth() auth: AuthContext) {
    return this.integrations.listKeys(auth);
  }

  /** Not @Idempotent: the answer holds the key, which must never be stored for replay (audit 47 #3). */
  @Post('api-keys')
  createKey(@Auth() auth: AuthContext, @Body(new ZodPipe(createApiKeySchema)) body: CreateApiKeyInput) {
    return this.integrations.createKey(auth, body);
  }

  /** Revoking stays possible for a suspended or lapsed business: a leaked key must always be stoppable. */
  @AllowReadOnlyBusiness()
  @HttpCode(200)
  @Post('api-keys/:id/revoke')
  revokeKey(@Auth() auth: AuthContext, @Param('id', id) keyId: string) {
    return this.integrations.revokeKey(auth, keyId);
  }

  @Get('webhooks')
  listWebhooks(@Auth() auth: AuthContext) {
    return this.integrations.listWebhooks(auth);
  }

  /** Not @Idempotent: the answer holds the signing secret (audit 47 #3). */
  @Post('webhooks')
  createWebhook(@Auth() auth: AuthContext, @Body(new ZodPipe(createWebhookSchema)) body: CreateWebhookInput) {
    return this.integrations.createWebhook(auth, body);
  }

  @Patch('webhooks/:id')
  updateWebhook(@Auth() auth: AuthContext, @Param('id', id) endpointId: string, @Body(new ZodPipe(updateWebhookSchema)) body: UpdateWebhookInput) {
    return this.integrations.updateWebhook(auth, endpointId, body);
  }

  @HttpCode(200)
  @Post('webhooks/:id/rotate-secret')
  rotate(@Auth() auth: AuthContext, @Param('id', id) endpointId: string) {
    return this.integrations.rotateSecret(auth, endpointId);
  }

  @Post('webhooks/:id/ping')
  ping(@Auth() auth: AuthContext, @Param('id', id) endpointId: string) {
    return this.integrations.ping(auth, endpointId);
  }

  @Get('webhooks/:id/deliveries')
  deliveries(@Auth() auth: AuthContext, @Param('id', id) endpointId: string) {
    return this.integrations.deliveries(auth, endpointId);
  }

  @HttpCode(200)
  @Post('webhook-deliveries/:id/retry')
  retry(@Auth() auth: AuthContext, @Param('id', id) deliveryId: string) {
    return this.integrations.retryDelivery(auth, deliveryId);
  }
}
