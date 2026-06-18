import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { TaxCode } from '@prisma/client';
import { TaxCodeResponseDto } from './dto/tax-code-response.dto';
import { TaxCodeListResponseDto } from './dto/tax-code-list-response.dto';
import { TaxCodesService } from './tax-codes.service';
import { CreateTaxCodeDto } from './dto/create-tax-code.dto';
import { UpdateTaxCodeDto } from './dto/update-tax-code.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

@ApiTags('Tax')
@ApiBearerAuth()
@Controller('tax/codes')
export class TaxCodesController {
  constructor(private readonly taxCodes: TaxCodesService) {}

  @ApiOkResponse({ type: TaxCodeListResponseDto })
  @Get()
  list(@Query() q: PaginationQueryDto) {
    return this.taxCodes.list(q);
  }

  @ApiOkResponse({ type: TaxCodeResponseDto })
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<TaxCode> {
    return this.taxCodes.findById(id);
  }

  @ApiCreatedResponse({ type: TaxCodeResponseDto })
  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post()
  create(@Body() dto: CreateTaxCodeDto): Promise<TaxCode> {
    return this.taxCodes.create(dto);
  }

  @ApiOkResponse({ type: TaxCodeResponseDto })
  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaxCodeDto,
  ): Promise<TaxCode> {
    return this.taxCodes.update(id, dto);
  }

  @ApiOkResponse({ type: TaxCodeResponseDto })
  @Roles(Role.ADMIN)
  @Post(':id/deactivate')
  @HttpCode(200)
  deactivate(@Param('id', ParseUUIDPipe) id: string): Promise<TaxCode> {
    return this.taxCodes.deactivate(id);
  }

  @ApiNoContentResponse()
  @Roles(Role.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.taxCodes.softDelete(id, user.id);
  }
}
