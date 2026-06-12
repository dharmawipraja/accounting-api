import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';

@ApiTags('Audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Roles(Role.ADMIN)
  @Get()
  list(@Query() q: AuditQueryDto) {
    return this.audit.list({
      userId: q.userId,
      method: q.method,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    });
  }
}
