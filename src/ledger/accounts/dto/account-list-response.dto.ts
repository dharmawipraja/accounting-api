import { PaginatedDto } from '../../../common/openapi/paginated-dto';
import { AccountResponseDto } from './account-response.dto';

export const AccountListResponseDto = PaginatedDto(
  AccountResponseDto,
  'AccountListResponseDto',
  { totalExample: 28 },
);
