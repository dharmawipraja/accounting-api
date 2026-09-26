import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { TaxService, TaxCalculation } from './tax.service';
import { TaxCalculationDto } from './dto/tax-calculation-response.dto';
import { CalculateTaxDto } from './dto/calculate-tax.dto';
import { ReadOnlyPost } from '../audit/read-only-post';

@ApiTags('Tax')
@ApiBearerAuth()
@Controller('tax')
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  @ApiOkResponse({ type: TaxCalculationDto })
  @Post('calculate')
  @HttpCode(200)
  @ReadOnlyPost()
  calculate(@Body() dto: CalculateTaxDto): Promise<TaxCalculation> {
    return this.tax.calculate(dto);
  }
}
