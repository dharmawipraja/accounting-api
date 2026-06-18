import { PaginatedDto } from '../../common/openapi/paginated-dto';
import { TaxCodeResponseDto } from './tax-code-response.dto';

export const TaxCodeListResponseDto = PaginatedDto(
  TaxCodeResponseDto,
  'TaxCodeListResponseDto',
  { totalExample: 6 },
);
