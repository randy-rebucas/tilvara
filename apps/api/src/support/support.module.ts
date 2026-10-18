import { Module } from '@nestjs/common';
import type { ServerEnv } from '@1pos/config';
import { DevFileStorage } from '@1pos/database';
import { AuthModule } from '../auth/auth.module.js';
import { DataExportController, DataExportFileController } from '../exports/data-export.controller.js';
import { DataExportService, EXPORT_LINKS, FILE_STORAGE } from '../exports/data-export.service.js';
import { ExportLinks } from '../exports/export-links.js';
import { ENV } from '../infrastructure/env.provider.js';
import { SupportAccessController, SupportStaffController } from './support.controller.js';
import { SupportService } from './support.service.js';

/** Onboarding and support (ADR-0016 slice 6): support access and data exports. */
@Module({
  imports: [AuthModule],
  controllers: [SupportAccessController, SupportStaffController, DataExportController, DataExportFileController],
  providers: [
    SupportService,
    DataExportService,
    // Only the dev adapter exists until D1 (production refuses FILE_STORAGE_DRIVER=dev at boot).
    { provide: FILE_STORAGE, useFactory: (env: ServerEnv) => new DevFileStorage(env.FILE_STORAGE_DIR), inject: [ENV] },
    { provide: EXPORT_LINKS, useFactory: (env: ServerEnv) => new ExportLinks(env.JWT_ACCESS_SECRET), inject: [ENV] },
  ],
})
export class SupportModule {}
