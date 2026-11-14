import { IsObject, IsUrl, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

/**
 * Sync a store's menu from the BROWN system.
 * Either the POS calls the BROWN API (devKid + accessToken), or `response` is a menu response
 * pasted from Postman (when the POS server cannot reach the BROWN API).
 */
export class BrownSyncDto {
  /** BROWN menu API address. Empty = BROWN_MENU_API_URL (default https://dev.brown.com.kh/Client_API/V7/item_menu/) */
  @IsOptional() @ValidateIf((_, v) => v !== '') @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false }, { message: 'API URL must start with http:// or https://' }) @MaxLength(300)
  apiUrl?: string;

  /** BROWN app username: only for the brown_app_menu_listing API */
  @IsOptional() @IsString() @MaxLength(100)
  username?: string;

  /** The store's id in BROWN (idoutlet). Saved on the store; defaults to the one already saved. */
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{1,50}$/, { message: 'BROWN store id: letters and digits only' })
  brownStoreId?: string;

  @ValidateIf((o) => !o.response) @IsString() @Matches(/^\d{6,30}$/, { message: 'dev_kid is a number, e.g. 520220510160112129' })
  devKid?: string;

  /** user_access_token from the BROWN guest login */
  @ValidateIf((o) => !o.response) @IsString() @MaxLength(1000)
  accessToken?: string;

  /** Leave empty: the POS calculates it from the token and dev_kid (it changes every month). */
  @IsOptional() @IsString() @MaxLength(1000)
  dataEncryption?: string;

  /** A brown_app_menu_listing / item_menu response pasted from Postman */
  @IsOptional() @IsObject()
  response?: Record<string, unknown>;
}
