import { ApiProperty } from '@nestjs/swagger';
import { AccountResponseDto } from './account-response.dto';

export class AccountListResponseDto {
  @ApiProperty({ type: [AccountResponseDto] }) data!: AccountResponseDto[];
  @ApiProperty({ example: 28 }) total!: number;
  @ApiProperty({ example: 50 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}
