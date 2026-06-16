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
import {
  BusinessPartnerListResponseDto,
  BusinessPartnerResponseDto,
} from './dto/business-partner-response.dto';
import { BusinessPartner } from '@prisma/client';
import { SearchQueryDto } from '../common/dto/search-query.dto';
import { BusinessPartnersService } from './business-partners.service';
import { CreateBusinessPartnerDto } from './dto/create-business-partner.dto';
import { UpdateBusinessPartnerDto } from './dto/update-business-partner.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

@ApiTags('Business Partners')
@ApiBearerAuth()
@Controller('partners')
export class BusinessPartnersController {
  constructor(private readonly partners: BusinessPartnersService) {}

  @ApiOkResponse({ type: BusinessPartnerListResponseDto })
  @Get()
  list(@Query() q: SearchQueryDto) {
    return this.partners.listPage(q);
  }
  @ApiOkResponse({ type: BusinessPartnerResponseDto })
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<BusinessPartner> {
    return this.partners.findById(id);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @ApiCreatedResponse({ type: BusinessPartnerResponseDto })
  @Post()
  create(@Body() dto: CreateBusinessPartnerDto): Promise<BusinessPartner> {
    return this.partners.create(dto);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @ApiOkResponse({ type: BusinessPartnerResponseDto })
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBusinessPartnerDto,
  ): Promise<BusinessPartner> {
    return this.partners.update(id, dto);
  }

  @Roles(Role.ADMIN)
  @ApiOkResponse({ type: BusinessPartnerResponseDto })
  @Post(':id/deactivate')
  @HttpCode(200)
  deactivate(@Param('id', ParseUUIDPipe) id: string): Promise<BusinessPartner> {
    return this.partners.deactivate(id);
  }

  @Roles(Role.ADMIN)
  @ApiNoContentResponse()
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.partners.softDelete(id, user.id);
  }
}
