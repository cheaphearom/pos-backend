import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'crypto';

/**
 * Rate-limit per API key / login session instead of per IP address.
 * Many POS terminals in one store usually share a single public IP,
 * so limiting by IP would block a busy store.
 */
@Injectable()
export class ClientThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const credential = (req.headers?.['x-api-key'] as string) || (req.headers?.authorization as string);
    if (credential) return 'c:' + createHash('sha256').update(credential).digest('hex').slice(0, 32);
    return 'ip:' + (req.ips?.length ? req.ips[0] : req.ip);
  }
}
