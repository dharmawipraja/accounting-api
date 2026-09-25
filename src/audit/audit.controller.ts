import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AuditEntryDto } from './dto/audit-entry-response.dto';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { optionalDateRange } from '../common/dates/query-dates';
import { parseDate } from '../common/dates/parse-date';
import { Role } from '../auth/role.enum';

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Roles(Role.ADMIN)
  @ApiOkResponse({ type: AuditEntryDto, isArray: true })
  @Get()
  list(@Query() q: AuditQueryDto) {
    // Audit rows are instants: keep the full timestamp (not a business date).
    const { from, to } = optionalDateRange(q.from, q.to, parseDate);
    return this.audit.list({
      userId: q.userId,
      method: q.method,
      from,
      to,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    });
  }
}
