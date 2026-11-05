import { IsDateString, IsOptional, IsUUID } from 'class-validator';
import { PageQueryDto } from './pagination';

export class DateRangeQueryDto extends PageQueryDto {
  /** Filter by store */
  @IsOptional() @IsUUID()
  storeId?: string;

  /** ISO date, inclusive, e.g. 2026-01-01 */
  @IsOptional() @IsDateString()
  from?: string;

  /** ISO date, inclusive, e.g. 2026-01-31 */
  @IsOptional() @IsDateString()
  to?: string;
}

/** Converts from/to (dates) into a Prisma DateTime filter where `to` covers the whole day. */
export function dateFilter(from?: string, to?: string) {
  if (!from && !to) return undefined;
  const f: { gte?: Date; lt?: Date } = {};
  if (from) f.gte = new Date(from);
  if (to) {
    const end = new Date(to);
    if (to.length <= 10) end.setUTCDate(end.getUTCDate() + 1);
    f.lt = end;
  }
  return f;
}
