/**
 * Shape of a country as returned by https://countries.dev/name/{query}.
 *
 * The endpoint answers with REST Countries v3 style objects, but every field
 * except the name is treated as optional: the payload comes from an external
 * service, so the view-model layer has to cope with missing fields instead of
 * trusting the response.
 */
export interface ApiCountry {
  name: string;
  nativeName?: string;
  capital?: string;
  region?: string;
  subregion?: string;
  population?: number;
  area?: number;
  /** Emoji flag, convenient as a fallback when the image is unavailable. */
  flag?: string;
  flags?: ApiCountryFlags;
  languages?: ApiLanguage[];
  currencies?: ApiCurrency[];
  /** Alpha-3 codes of the neighbouring countries. */
  borders?: string[];
  demonym?: string;
  independent?: boolean;
}

export interface ApiCountryFlags {
  svg?: string;
  png?: string;
}

export interface ApiLanguage {
  name?: string;
  iso639_1?: string;
}

export interface ApiCurrency {
  code?: string;
  name?: string;
  symbol?: string;
}
