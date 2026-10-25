import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { AnalysisReportsService } from './analysis-reports.service.js';
import { SalonReportsService } from './salon-reports.service.js';

@Module({ controllers: [ReportsController], providers: [ReportsService, AnalysisReportsService, SalonReportsService] })
export class ReportsModule {}
