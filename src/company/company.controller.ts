import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CompanySettings } from '@prisma/client';
import { CompanyService } from './company.service';
import { UpdateCompanySettingsDto } from './dto/update-company-settings.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CompanySettingsDto } from './dto/company-settings-response.dto';

@ApiTags('Company')
@ApiBearerAuth()
@Controller('company/settings')
export class CompanyController {
  constructor(private readonly company: CompanyService) {}

  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  @Get()
  @ApiOkResponse({ type: CompanySettingsDto })
  get(): Promise<CompanySettings> {
    return this.company.get();
  }

  @Roles(Role.ADMIN)
  @Patch()
  @ApiOkResponse({ type: CompanySettingsDto })
  update(@Body() dto: UpdateCompanySettingsDto): Promise<CompanySettings> {
    return this.company.update(dto);
  }
}
