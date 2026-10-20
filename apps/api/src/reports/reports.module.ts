import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { RestaurantReportsService } from './restaurant-reports.service.js';
import { AnalysisReportsService } from './analysis-reports.service.js';

@Module({ controllers: [ReportsController], providers: [ReportsService, RestaurantReportsService, AnalysisReportsService] })
export class ReportsModule {}
