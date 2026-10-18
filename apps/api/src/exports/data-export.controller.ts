import { Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { idParamSchema } from '@1pos/validation';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { AllowReadOnlyBusiness, Auth, Public, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { RateLimit } from '../infrastructure/rate-limit.guard.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { DataExportService } from './data-export.service.js';

const id = new ZodPipe(idParamSchema);

@RequireTenant()
@Controller('data-exports')
export class DataExportController {
  constructor(@Inject(DataExportService) private readonly exports: DataExportService) {}

  @Get()
  list(@Auth() auth: AuthContext) {
    return this.exports.list(auth);
  }

  @Get(':id')
  get(@Auth() auth: AuthContext, @Param('id', id) exportId: string) {
    return this.exports.get(auth, exportId);
  }

  @AllowReadOnlyBusiness()
  @Idempotent()
  @HttpCode(202)
  @Post()
  request(@Auth() auth: AuthContext) {
    return this.exports.request(auth);
  }

  @AllowReadOnlyBusiness()
  @HttpCode(200)
  @Post(':id/link')
  link(@Auth() auth: AuthContext, @Param('id', id) exportId: string) {
    return this.exports.link(auth, exportId);
  }
}

/** The file behind a signed link (no session: the link is the credential, for a few minutes). */
@Controller('data-export-files')
export class DataExportFileController {
  constructor(@Inject(DataExportService) private readonly exports: DataExportService) {}

  @Public()
  @RateLimit({ bucket: 'export-download', limit: 30, windowSeconds: 600 })
  @Get(':token')
  async download(@Param('token') token: string, @Res() res: Response): Promise<void> {
    const file = await this.exports.open(token);
    res.status(200).set({
      'content-type': 'application/zip',
      'content-length': String(file.sizeBytes),
      'content-disposition': `attachment; filename="${file.filename}"`,
      'cache-control': 'no-store',
      'x-content-sha256': file.sha256,
    });
    await pipeline(file.stream, res);
  }
}
