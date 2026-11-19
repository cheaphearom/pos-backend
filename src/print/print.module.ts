// Copyright (c) 2026 Chea Phearom. All rights reserved.
// Proprietary and confidential: see the LICENSE file.
/**
 * Printing to named printers (receipt printer, kitchen printer) goes through QZ Tray, a small program on each till
 * computer. QZ Tray asks "Allow this website to print?" unless the requests are signed with a certificate it trusts.
 * This module hands the POS the certificate and signs each request with the matching private key, which stays on
 * the server (env QZ_CERTIFICATE and QZ_PRIVATE_KEY, PEM; "\n" may be written as \n on one line).
 * Without them, QZ Tray still prints but asks the cashier to allow it.
 */
import { BadRequestException, Body, Controller, Get, Header, HttpCode, Module, Post, ServiceUnavailableException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createSign } from 'crypto';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** PEM from an env value: real line breaks, or \n written in one line. */
export const pemFromEnv = (v: string | undefined) => (v ?? '').replace(/\\n/g, '\n').trim();

export function signQz(toSign: string, privateKeyPem: string): string {
  const s = createSign('RSA-SHA512');
  s.update(toSign);
  return s.sign(privateKeyPem, 'base64');
}

export class SignDto {
  /** The text QZ Tray asks the page to sign */
  @IsString() @MinLength(1) @MaxLength(20000)
  request: string;
}

@ApiTags('Printing')
@ApiBearerAuth()
@Controller('print')
export class PrintController {
  /** The certificate QZ Tray checks (empty when printing is not signed yet). Any staff member. */
  @Get('qz-certificate')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  certificate() {
    return pemFromEnv(process.env.QZ_CERTIFICATE);
  }

  /** Signs one QZ Tray request (SHA-512 with RSA). Any staff member. */
  @Post('qz-sign')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain; charset=utf-8')
  sign(@Body() dto: SignDto) {
    const key = pemFromEnv(process.env.QZ_PRIVATE_KEY);
    if (!key) throw new ServiceUnavailableException('Printing is not signed on this server (QZ_PRIVATE_KEY is not set)');
    try {
      return signQz(dto.request, key);
    } catch {
      throw new BadRequestException('Could not sign the print request: check QZ_PRIVATE_KEY');
    }
  }
}

@Module({ controllers: [PrintController] })
export class PrintModule {}
