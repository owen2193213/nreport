import { randomBytes, randomInt } from "node:crypto";

import { faker } from "@faker-js/faker";
import transliterate from "@sindresorhus/transliterate";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

interface CountryProfile {
  locale: string;
  language: string;
  timezone: string;
}

const COUNTRY_PROFILES: Readonly<Record<string, readonly CountryProfile[]>> = {
  AT: [{ locale: "de-AT", language: "de", timezone: "Europe/Vienna" }],
  BE: [
    { locale: "nl-BE", language: "nl", timezone: "Europe/Brussels" },
    { locale: "fr-BE", language: "fr", timezone: "Europe/Brussels" }
  ],
  BG: [{ locale: "bg-BG", language: "bg", timezone: "Europe/Sofia" }],
  HR: [{ locale: "hr-HR", language: "hr", timezone: "Europe/Zagreb" }],
  CY: [{ locale: "el-CY", language: "el", timezone: "Asia/Nicosia" }],
  CZ: [{ locale: "cs-CZ", language: "cs", timezone: "Europe/Prague" }],
  DK: [{ locale: "da-DK", language: "da", timezone: "Europe/Copenhagen" }],
  EE: [{ locale: "et-EE", language: "et", timezone: "Europe/Tallinn" }],
  FI: [{ locale: "fi-FI", language: "fi", timezone: "Europe/Helsinki" }],
  FR: [{ locale: "fr-FR", language: "fr", timezone: "Europe/Paris" }],
  DE: [{ locale: "de-DE", language: "de", timezone: "Europe/Berlin" }],
  GR: [{ locale: "el-GR", language: "el", timezone: "Europe/Athens" }],
  HU: [{ locale: "hu-HU", language: "hu", timezone: "Europe/Budapest" }],
  IE: [{ locale: "en-IE", language: "en", timezone: "Europe/Dublin" }],
  IT: [{ locale: "it-IT", language: "it", timezone: "Europe/Rome" }],
  LV: [{ locale: "lv-LV", language: "lv", timezone: "Europe/Riga" }],
  LT: [{ locale: "lt-LT", language: "lt", timezone: "Europe/Vilnius" }],
  LU: [{ locale: "fr-LU", language: "fr", timezone: "Europe/Luxembourg" }],
  MT: [{ locale: "mt-MT", language: "mt", timezone: "Europe/Malta" }],
  NL: [{ locale: "nl-NL", language: "nl", timezone: "Europe/Amsterdam" }],
  PL: [{ locale: "pl-PL", language: "pl", timezone: "Europe/Warsaw" }],
  PT: [{ locale: "pt-PT", language: "pt", timezone: "Europe/Lisbon" }],
  RO: [{ locale: "ro-RO", language: "ro", timezone: "Europe/Bucharest" }],
  SK: [{ locale: "sk-SK", language: "sk", timezone: "Europe/Bratislava" }],
  SI: [{ locale: "sl-SI", language: "sl", timezone: "Europe/Ljubljana" }],
  ES: [{ locale: "es-ES", language: "es", timezone: "Europe/Madrid" }],
  SE: [{ locale: "sv-SE", language: "sv", timezone: "Europe/Stockholm" }]
};

export interface GeneratedIdentity {
  country: string;
  displayName: string;
  email: string;
  internalReportId: string;
  timezone: string;
  locale: string;
  language: string;
}

export function supportedCountries(): string[] {
  return Object.keys(COUNTRY_PROFILES).sort();
}

function slugify(value: string, language: string): string {
  return transliterate(value, { locale: language })
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function uniqueSuffix(): string {
  const bytes = randomBytes(10);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let suffix = "";
  for (let index = 0; index < 16; index += 1) {
    suffix = CROCKFORD[Number(value & 31n)] + suffix;
    value >>= 5n;
  }
  return suffix;
}

function emailFromSlug(slug: string, suffix: string, emailDomain: string): string {
  return `${slug.replace(/-/g, ".")}.${suffix}@${emailDomain}`;
}

function select<T>(values: readonly T[]): T {
  const value = values[randomInt(values.length)];
  if (value === undefined) throw new Error("Pseudonym profile is empty.");
  return value;
}

function generateDisplayName(): string {
  const sex = faker.person.sexType();
  return `${faker.person.firstName(sex)} ${faker.person.lastName(sex)}`;
}

export function buildAcceptLanguage(locale: string, language: string): string {
  return language === "en"
    ? `${locale},en;q=0.9`
    : `${locale},${language};q=0.9,en;q=0.7`;
}

export function createProxySessionId(): string {
  const value = BigInt(`0x${randomBytes(8).toString("hex")}`) % 1_000_000_000_000n;
  return value.toString().padStart(12, "0");
}

export function generateEmailAlias(
  displayName: string,
  language: string,
  emailDomain: string
): string {
  const slug = slugify(displayName, language);
  if (slug.length === 0) throw new Error("Pseudonym could not be converted to an email alias.");
  return emailFromSlug(slug, uniqueSuffix(), emailDomain);
}

export function generateIdentity(country: string, emailDomain: string): GeneratedIdentity {
  const normalizedCountry = country.toUpperCase();
  const profiles = COUNTRY_PROFILES[normalizedCountry];
  if (!profiles) {
    throw new Error(
      `Unsupported country ${normalizedCountry}. Supported countries: ${supportedCountries().join(", ")}.`
    );
  }
  const profile = select(profiles);
  const displayName = generateDisplayName();
  const slug = slugify(displayName, profile.language);
  if (slug.length === 0) throw new Error("Pseudonym could not be converted to an email-safe ID.");
  const suffix = uniqueSuffix();
  return {
    country: normalizedCountry,
    displayName,
    email: emailFromSlug(slug, suffix, emailDomain),
    internalReportId: `${slug}-${suffix}`,
    timezone: profile.timezone,
    locale: profile.locale,
    language: profile.language
  };
}

export function buildProxyUrl(
  template: string | undefined,
  country: string,
  sessionId: string
): string | undefined {
  if (template === undefined) return undefined;
  return template
    .replaceAll("{country}", encodeURIComponent(country.toUpperCase()))
    .replaceAll("{session}", encodeURIComponent(sessionId));
}
