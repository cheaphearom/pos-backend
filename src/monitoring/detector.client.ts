import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { detectorConfig } from '../config';

/**
 * Talks to the ML anomaly detector (monitoring/ml-detector) over the internal network.
 * The browser never calls the detector: the monitoring endpoints of this API proxy it.
 */
@Injectable()
export class DetectorClient {
  async get<T = any>(path: string, timeoutMs = 4000): Promise<T> {
    return this.call<T>('GET', path, timeoutMs);
  }

  async post<T = any>(path: string, timeoutMs = 20_000): Promise<T> {
    return this.call<T>('POST', path, timeoutMs);
  }

  private async call<T>(method: string, path: string, timeoutMs: number): Promise<T> {
    if (!detectorConfig.url) throw new ServiceUnavailableException('The anomaly detector is not set up (DETECTOR_URL)');
    let res: Response;
    try {
      res = await fetch(detectorConfig.url + path, {
        method,
        headers: detectorConfig.apiKey ? { 'X-API-Key': detectorConfig.apiKey } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ServiceUnavailableException('The anomaly detector is not reachable');
    }
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      // e.g. 400 "Telegram is not configured", 502 "could not reach Telegram"
      const status = res.status === 401 ? 502 : res.status;
      const message =
        res.status === 401 ? 'The detector refused the API key (DETECTOR_API_KEY)'
        : typeof body?.detail === 'string' ? body.detail
        : `The detector answered HTTP ${res.status}`;
      throw new HttpException({ statusCode: status, message }, status);
    }
    return body as T;
  }
}
