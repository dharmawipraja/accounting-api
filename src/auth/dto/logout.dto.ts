import { IsString, MaxLength } from 'class-validator';

export class LogoutDto {
  @IsString()
  @MaxLength(2048) // a refresh JWT is ~300 chars; bound the input
  refreshToken!: string;
}
