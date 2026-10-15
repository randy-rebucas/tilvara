import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  addBarcodeSchema,
  addVariantSchema,
  assignPriceListSchema,
  createCategorySchema,
  createPriceListSchema,
  createProductSchema,
  createTaxCategorySchema,
  createUomSchema,
  idParamSchema,
  lookupQuerySchema,
  productListQuerySchema,
  setPricesSchema,
  updateCategorySchema,
  updatePriceListSchema,
  updateProductSchema,
  updateVariantSchema,
  type AssignPriceListInput,
  type CreateCategoryInput,
  type CreatePriceListInput,
  type CreateProductInput,
  type CreateTaxCategoryInput,
  type CreateUomInput,
  type LookupQuery,
  type ProductListQuery,
  type SetPricesInput,
  type UpdateCategoryInput,
  type UpdatePriceListInput,
  type UpdateProductInput,
  type UpdateVariantInput,
  type VariantInput,
} from '@1pos/validation';
import { Auth, RequireTenant, type AuthContext } from '../auth/auth-context.js';
import { Idempotent } from '../infrastructure/idempotency.js';
import { ZodPipe } from '../infrastructure/zod-validation.pipe.js';
import { CatalogService } from './catalog.service.js';
import { PricingService } from './pricing.service.js';

const id = new ZodPipe(idParamSchema);

@RequireTenant()
@Controller()
export class CatalogController {
  constructor(
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(PricingService) private readonly pricing: PricingService,
  ) {}

  // units & tax categories
  @Get('uoms')
  async listUoms(@Auth() auth: AuthContext) {
    return { data: await this.catalog.listUoms(auth) };
  }

  @Post('uoms')
  createUom(@Auth() auth: AuthContext, @Body(new ZodPipe(createUomSchema)) body: CreateUomInput) {
    return this.catalog.createUom(auth, body);
  }

  @Get('tax-categories')
  async listTaxCategories(@Auth() auth: AuthContext) {
    return { data: await this.catalog.listTaxCategories(auth) };
  }

  @Post('tax-categories')
  createTaxCategory(@Auth() auth: AuthContext, @Body(new ZodPipe(createTaxCategorySchema)) body: CreateTaxCategoryInput) {
    return this.catalog.createTaxCategory(auth, body);
  }

  // categories
  @Get('categories')
  async listCategories(@Auth() auth: AuthContext) {
    return { data: await this.catalog.listCategories(auth) };
  }

  @Idempotent()
  @Post('categories')
  createCategory(@Auth() auth: AuthContext, @Body(new ZodPipe(createCategorySchema)) body: CreateCategoryInput) {
    return this.catalog.createCategory(auth, body);
  }

  @Patch('categories/:id')
  updateCategory(@Auth() auth: AuthContext, @Param('id', id) categoryId: string, @Body(new ZodPipe(updateCategorySchema)) body: UpdateCategoryInput) {
    return this.catalog.updateCategory(auth, categoryId, body);
  }

  @HttpCode(200)
  @Post('categories/:id/archive')
  archiveCategory(@Auth() auth: AuthContext, @Param('id', id) categoryId: string) {
    return this.catalog.archiveCategory(auth, categoryId);
  }

  // products
  @Get('products')
  listProducts(@Auth() auth: AuthContext, @Query(new ZodPipe(productListQuerySchema)) query: ProductListQuery) {
    return this.catalog.listProducts(auth, query);
  }

  @Idempotent()
  @Post('products')
  createProduct(@Auth() auth: AuthContext, @Body(new ZodPipe(createProductSchema)) body: CreateProductInput) {
    return this.catalog.createProduct(auth, body);
  }

  @Get('products/:id')
  getProduct(@Auth() auth: AuthContext, @Param('id', id) productId: string) {
    return this.catalog.getProduct(auth, productId);
  }

  @Patch('products/:id')
  updateProduct(@Auth() auth: AuthContext, @Param('id', id) productId: string, @Body(new ZodPipe(updateProductSchema)) body: UpdateProductInput) {
    return this.catalog.updateProduct(auth, productId, body);
  }

  @HttpCode(200)
  @Post('products/:id/archive')
  archiveProduct(@Auth() auth: AuthContext, @Param('id', id) productId: string) {
    return this.catalog.archiveProduct(auth, productId);
  }

  @Idempotent()
  @Post('products/:id/variants')
  addVariant(@Auth() auth: AuthContext, @Param('id', id) productId: string, @Body(new ZodPipe(addVariantSchema)) body: VariantInput) {
    return this.catalog.addVariant(auth, productId, body);
  }

  @Patch('variants/:id')
  updateVariant(@Auth() auth: AuthContext, @Param('id', id) variantId: string, @Body(new ZodPipe(updateVariantSchema)) body: UpdateVariantInput) {
    return this.catalog.updateVariant(auth, variantId, body);
  }

  @HttpCode(200)
  @Post('variants/:id/archive')
  archiveVariant(@Auth() auth: AuthContext, @Param('id', id) variantId: string) {
    return this.catalog.archiveVariant(auth, variantId);
  }

  @Post('variants/:id/barcodes')
  addBarcode(@Auth() auth: AuthContext, @Param('id', id) variantId: string, @Body(new ZodPipe(addBarcodeSchema)) body: { code: string }) {
    return this.catalog.addBarcode(auth, variantId, body.code);
  }

  @HttpCode(200)
  @Post('barcodes/:id/archive')
  archiveBarcode(@Auth() auth: AuthContext, @Param('id', id) barcodeId: string) {
    return this.catalog.archiveBarcode(auth, barcodeId);
  }

  @Get('variants/:id/price-history')
  priceHistory(@Auth() auth: AuthContext, @Param('id', id) variantId: string) {
    return this.pricing.priceHistory(auth, variantId);
  }

  // POS lookup
  @Get('catalog/lookup')
  lookup(@Auth() auth: AuthContext, @Query(new ZodPipe(lookupQuerySchema)) query: LookupQuery) {
    return this.pricing.lookup(auth, query.code, query.branchId);
  }

  // price lists
  @Get('price-lists')
  async listPriceLists(@Auth() auth: AuthContext) {
    return { data: await this.pricing.listPriceLists(auth) };
  }

  @Idempotent()
  @Post('price-lists')
  createPriceList(@Auth() auth: AuthContext, @Body(new ZodPipe(createPriceListSchema)) body: CreatePriceListInput) {
    return this.pricing.createPriceList(auth, body);
  }

  @Patch('price-lists/:id')
  updatePriceList(@Auth() auth: AuthContext, @Param('id', id) listId: string, @Body(new ZodPipe(updatePriceListSchema)) body: UpdatePriceListInput) {
    return this.pricing.updatePriceList(auth, listId, body);
  }

  @Get('price-lists/:id/prices')
  currentPrices(@Auth() auth: AuthContext, @Param('id', id) listId: string) {
    return this.pricing.currentPrices(auth, listId);
  }

  @Idempotent()
  @Post('price-lists/:id/prices')
  setPrices(@Auth() auth: AuthContext, @Param('id', id) listId: string, @Body(new ZodPipe(setPricesSchema)) body: SetPricesInput) {
    return this.pricing.setPrices(auth, listId, body);
  }

  @Put('branches/:id/price-list')
  assignBranchPriceList(@Auth() auth: AuthContext, @Param('id', id) branchId: string, @Body(new ZodPipe(assignPriceListSchema)) body: AssignPriceListInput) {
    return this.pricing.assignBranchPriceList(auth, branchId, body);
  }
}
