import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { TaxService, TaxCalculation } from './tax.service';
import { TaxCalculationDto } from './dto/tax-calculation-response.dto';
import { CalculateTaxDto } from './dto/calculate-tax.dto';

@ApiTags('Tax')
@ApiBearerAuth()
@Controller('tax')
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  @ApiOkResponse({ type: TaxCalculationDto })
  @Post('calculate')
  @HttpCode(200)
  calculate(@Body() dto: CalculateTaxDto): Promise<TaxCalculation> {
    return this.tax.calculate(dto);
  }
}
