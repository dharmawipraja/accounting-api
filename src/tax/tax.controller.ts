import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { TaxService, TaxCalculation } from './tax.service';
import { CalculateTaxDto } from './dto/calculate-tax.dto';

@ApiTags('Tax')
@ApiBearerAuth()
@Controller('tax')
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  @Post('calculate')
  @HttpCode(200)
  calculate(@Body() dto: CalculateTaxDto): Promise<TaxCalculation> {
    return this.tax.calculate(dto);
  }
}
