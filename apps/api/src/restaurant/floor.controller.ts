import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  branchQuerySchema,
  createDiningAreaSchema,
  createKitchenStationSchema,
  createRestaurantTableSchema,
  idParamSchema,
  restaurantSettingsSchema,
  soldOutSchema,
  updateDiningAreaSchema,
  updateKitchenStationSchema,
  updateRestaurantTableSchema,
  type BranchQuery,
  type CreateDiningAreaInput,
  type CreateKitchenStationInput,
  type CreateRestaurantTableInput,
  type RestaurantSettingsInput,
  type SoldOutInput,
  type UpdateDiningAreaInput,
  type UpdateKitchenStationInput,
  type UpdateRestaurantTableInput,
} from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { FloorService } from './floor.service.js';

const id = new ZodPipe(idParamSchema);

/** Branch restaurant set-up (ADR-0014 §5, §9). Branch-scoped permissions are checked in the service. */
@RequireTenant()
@Controller()
export class FloorController {
  constructor(@Inject(FloorService) private readonly floor: FloorService) {}

  @Get('kitchen-stations')
  listStations(@Auth() auth: AuthContext, @Query(new ZodPipe(branchQuerySchema)) q: BranchQuery) {
    return this.floor.listStations(auth, q.branchId);
  }

  @Idempotent()
  @Post('kitchen-stations')
  createStation(@Auth() auth: AuthContext, @Body(new ZodPipe(createKitchenStationSchema)) body: CreateKitchenStationInput) {
    return this.floor.createStation(auth, body);
  }

  @Patch('kitchen-stations/:id')
  updateStation(@Auth() auth: AuthContext, @Param('id', id) stationId: string, @Body(new ZodPipe(updateKitchenStationSchema)) body: UpdateKitchenStationInput) {
    return this.floor.updateStation(auth, stationId, body);
  }

  @HttpCode(200)
  @Post('kitchen-stations/:id/archive')
  archiveStation(@Auth() auth: AuthContext, @Param('id', id) stationId: string) {
    return this.floor.archiveStation(auth, stationId);
  }

  @Get('dining-areas')
  listAreas(@Auth() auth: AuthContext, @Query(new ZodPipe(branchQuerySchema)) q: BranchQuery) {
    return this.floor.listAreas(auth, q.branchId);
  }

  @Idempotent()
  @Post('dining-areas')
  createArea(@Auth() auth: AuthContext, @Body(new ZodPipe(createDiningAreaSchema)) body: CreateDiningAreaInput) {
    return this.floor.createArea(auth, body);
  }

  @Patch('dining-areas/:id')
  updateArea(@Auth() auth: AuthContext, @Param('id', id) areaId: string, @Body(new ZodPipe(updateDiningAreaSchema)) body: UpdateDiningAreaInput) {
    return this.floor.updateArea(auth, areaId, body);
  }

  @HttpCode(200)
  @Post('dining-areas/:id/archive')
  archiveArea(@Auth() auth: AuthContext, @Param('id', id) areaId: string) {
    return this.floor.archiveArea(auth, areaId);
  }

  @Idempotent()
  @Post('restaurant-tables')
  createTable(@Auth() auth: AuthContext, @Body(new ZodPipe(createRestaurantTableSchema)) body: CreateRestaurantTableInput) {
    return this.floor.createTable(auth, body);
  }

  @Patch('restaurant-tables/:id')
  updateTable(@Auth() auth: AuthContext, @Param('id', id) tableId: string, @Body(new ZodPipe(updateRestaurantTableSchema)) body: UpdateRestaurantTableInput) {
    return this.floor.updateTable(auth, tableId, body);
  }

  @HttpCode(200)
  @Post('restaurant-tables/:id/archive')
  archiveTable(@Auth() auth: AuthContext, @Param('id', id) tableId: string) {
    return this.floor.archiveTable(auth, tableId);
  }

  @Get('branches/:id/restaurant-settings')
  getSettings(@Auth() auth: AuthContext, @Param('id', id) branchId: string) {
    return this.floor.getSettings(auth, branchId);
  }

  @Put('branches/:id/restaurant-settings')
  putSettings(@Auth() auth: AuthContext, @Param('id', id) branchId: string, @Body(new ZodPipe(restaurantSettingsSchema)) body: RestaurantSettingsInput) {
    return this.floor.putSettings(auth, branchId, body);
  }

  @Get('branches/:id/sold-out')
  listSoldOut(@Auth() auth: AuthContext, @Param('id', id) branchId: string) {
    return this.floor.listSoldOut(auth, branchId);
  }

  @Put('branches/:id/sold-out')
  setSoldOut(@Auth() auth: AuthContext, @Param('id', id) branchId: string, @Body(new ZodPipe(soldOutSchema)) body: SoldOutInput) {
    return this.floor.setSoldOut(auth, branchId, body);
  }
}
