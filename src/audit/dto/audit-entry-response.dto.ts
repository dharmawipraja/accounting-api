// src/audit/dto/audit-entry-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class AuditEntryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) timestamp!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) userId!: string | null;
  @ApiProperty({ nullable: true, example: 'ADMIN' }) userRole!: string | null;
  @ApiProperty({ example: 'POST' }) method!: string;
  @ApiProperty({ example: '/ledger/journal-entries' }) path!: string;
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true })
  params!: Record<string, unknown> | null;
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true })
  body!: Record<string, unknown> | null;
  @ApiProperty({ example: 201 }) statusCode!: number;
  @ApiProperty({ example: 42 }) durationMs!: number;
  @ApiProperty({ nullable: true, example: '127.0.0.1' }) ip!: string | null;
}
