import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ExtensionsController } from './extensions.controller.js';
import { ExtensionsService } from './extensions.service.js';
import { EXTENSION_MANIFESTS, SERVER_EXTENSIONS } from './registry.js';

/** Extensions (ADR-0026): the catalog and the switch. Each extension's own module is imported next to this one in AppModule. */
@Module({
  imports: [AuthModule],
  controllers: [ExtensionsController],
  providers: [ExtensionsService, { provide: EXTENSION_MANIFESTS, useValue: SERVER_EXTENSIONS }],
  exports: [EXTENSION_MANIFESTS],
})
export class ExtensionsModule {}
