import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { BusinessPartner } from '@prisma/client';
import { BusinessPartnersService } from './business-partners.service';
import { CreateBusinessPartnerDto } from './dto/create-business-partner.dto';
import { UpdateBusinessPartnerDto } from './dto/update-business-partner.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

@Controller('partners')
export class BusinessPartnersController {
  constructor(private readonly partners: BusinessPartnersService) {}

  @Get() list(): Promise<BusinessPartner[]> {
    return this.partners.list();
  }
  @Get(':id') get(@Param('id') id: string): Promise<BusinessPartner> {
    return this.partners.findById(id);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Post()
  create(@Body() dto: CreateBusinessPartnerDto): Promise<BusinessPartner> {
    return this.partners.create(dto);
  }

  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateBusinessPartnerDto,
  ): Promise<BusinessPartner> {
    return this.partners.update(id, dto);
  }

  @Roles(Role.ADMIN)
  @Post(':id/deactivate')
  @HttpCode(200)
  deactivate(@Param('id') id: string): Promise<BusinessPartner> {
    return this.partners.deactivate(id);
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.partners.softDelete(id, user.id);
  }
}
