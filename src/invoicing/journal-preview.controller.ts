import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { JournalPreviewService } from './journal-preview.service';
import { JournalPreview } from './journal-preview.projection';
import { PreviewJournalEntryDto } from './dto/preview-journal-entry.dto';
import { JournalPreviewResponseDto } from './dto/journal-preview-response.dto';

@ApiTags('Journal entries')
@ApiBearerAuth()
@Controller('journal-entries')
export class JournalPreviewController {
  constructor(private readonly service: JournalPreviewService) {}

  @ApiOkResponse({ type: JournalPreviewResponseDto })
  @Post('preview')
  @HttpCode(200)
  preview(@Body() dto: PreviewJournalEntryDto): Promise<JournalPreview> {
    return this.service.preview(dto);
  }
}
