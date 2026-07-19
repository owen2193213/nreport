import { randomBytes, randomInt } from "node:crypto";

import {
  fakerCS_CZ,
  fakerDA,
  fakerDE,
  fakerDE_AT,
  fakerEL,
  fakerEN_IE,
  fakerES,
  fakerFI,
  fakerFR,
  fakerFR_BE,
  fakerFR_LU,
  fakerHR,
  fakerHU,
  fakerIT,
  fakerLV,
  fakerNL,
  fakerNL_BE,
  fakerPL,
  fakerPT_PT,
  fakerRO,
  fakerSK,
  fakerSL_SI,
  fakerSV
} from "@faker-js/faker";
import type { Faker } from "@faker-js/faker";
import transliterate from "@sindresorhus/transliterate";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

interface CountryProfile {
  faker?: Faker;
  fullNames?: readonly string[];
  locale: string;
  language: string;
  timezone: string;
}

const BULGARIAN_NAMES = [
  "Александър Димитров",
  "Борис Иванов",
  "Виктор Георгиев",
  "Георги Петров",
  "Даниел Николов",
  "Иван Стоянов",
  "Елена Димитрова",
  "Мария Иванова",
  "Никол Николова",
  "София Георгиева"
] as const;

const ESTONIAN_NAMES = [
  "Andres Tamm",
  "Karl Saar",
  "Kristjan Sepp",
  "Markus Mägi",
  "Martin Kask",
  "Anna Kukk",
  "Kadri Rebane",
  "Laura Ilves",
  "Liis Pärn",
  "Maarja Oja"
] as const;

const LITHUANIAN_NAMES = [
  "Jonas Kazlauskas",
  "Mantas Petrauskas",
  "Tomas Jankauskas",
  "Lukas Žukauskas",
  "Darius Paulauskas",
  "Austėja Kazlauskaitė",
  "Gabija Petrauskaitė",
  "Ieva Jankauskaitė",
  "Eglė Žukauskaitė",
  "Rūta Paulauskaitė"
] as const;

const MALTESE_NAMES = [
  "Andrew Borg",
  "Daniel Camilleri",
  "Joseph Farrugia",
  "Luke Galea",
  "Matthew Vella",
  "Claire Attard",
  "Elena Micallef",
  "Maria Muscat",
  "Sarah Spiteri",
  "Sophie Zammit"
] as const;

const COUNTRY_PROFILES: Readonly<Record<string, readonly CountryProfile[]>> = {
  AT: [{ faker: fakerDE_AT, locale: "de-AT", language: "de", timezone: "Europe/Vienna" }],
  BE: [
    { faker: fakerNL_BE, locale: "nl-BE", language: "nl", timezone: "Europe/Brussels" },
    { faker: fakerFR_BE, locale: "fr-BE", language: "fr", timezone: "Europe/Brussels" }
  ],
  BG: [{ fullNames: BULGARIAN_NAMES, locale: "bg-BG", language: "bg", timezone: "Europe/Sofia" }],
  HR: [{ faker: fakerHR, locale: "hr-HR", language: "hr", timezone: "Europe/Zagreb" }],
  CY: [{ faker: fakerEL, locale: "el-CY", language: "el", timezone: "Asia/Nicosia" }],
  CZ: [{ faker: fakerCS_CZ, locale: "cs-CZ", language: "cs", timezone: "Europe/Prague" }],
  DK: [{ faker: fakerDA, locale: "da-DK", language: "da", timezone: "Europe/Copenhagen" }],
  EE: [{ fullNames: ESTONIAN_NAMES, locale: "et-EE", language: "et", timezone: "Europe/Tallinn" }],
  FI: [{ faker: fakerFI, locale: "fi-FI", language: "fi", timezone: "Europe/Helsinki" }],
  FR: [{ faker: fakerFR, locale: "fr-FR", language: "fr", timezone: "Europe/Paris" }],
  DE: [{ faker: fakerDE, locale: "de-DE", language: "de", timezone: "Europe/Berlin" }],
  GR: [{ faker: fakerEL, locale: "el-GR", language: "el", timezone: "Europe/Athens" }],
  HU: [{ faker: fakerHU, locale: "hu-HU", language: "hu", timezone: "Europe/Budapest" }],
  IE: [{ faker: fakerEN_IE, locale: "en-IE", language: "en", timezone: "Europe/Dublin" }],
  IT: [{ faker: fakerIT, locale: "it-IT", language: "it", timezone: "Europe/Rome" }],
  LV: [{ faker: fakerLV, locale: "lv-LV", language: "lv", timezone: "Europe/Riga" }],
  LT: [{ fullNames: LITHUANIAN_NAMES, locale: "lt-LT", language: "lt", timezone: "Europe/Vilnius" }],
  LU: [{ faker: fakerFR_LU, locale: "fr-LU", language: "fr", timezone: "Europe/Luxembourg" }],
  MT: [{ fullNames: MALTESE_NAMES, locale: "mt-MT", language: "mt", timezone: "Europe/Malta" }],
  NL: [{ faker: fakerNL, locale: "nl-NL", language: "nl", timezone: "Europe/Amsterdam" }],
  PL: [{ faker: fakerPL, locale: "pl-PL", language: "pl", timezone: "Europe/Warsaw" }],
  PT: [{ faker: fakerPT_PT, locale: "pt-PT", language: "pt", timezone: "Europe/Lisbon" }],
  RO: [{ faker: fakerRO, locale: "ro-RO", language: "ro", timezone: "Europe/Bucharest" }],
  SK: [{ faker: fakerSK, locale: "sk-SK", language: "sk", timezone: "Europe/Bratislava" }],
  SI: [{ faker: fakerSL_SI, locale: "sl-SI", language: "sl", timezone: "Europe/Ljubljana" }],
  ES: [{ faker: fakerES, locale: "es-ES", language: "es", timezone: "Europe/Madrid" }],
  SE: [{ faker: fakerSV, locale: "sv-SE", language: "sv", timezone: "Europe/Stockholm" }]
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

function select<T>(values: readonly T[]): T {
  const value = values[randomInt(values.length)];
  if (value === undefined) throw new Error("Pseudonym profile is empty.");
  return value;
}

function generateDisplayName(profile: CountryProfile): string {
  if (profile.faker !== undefined) return profile.faker.person.fullName();
  if (profile.fullNames !== undefined) return select(profile.fullNames);
  throw new Error("Pseudonym profile has no name source.");
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

export function generateIdentity(country: string, emailDomain: string): GeneratedIdentity {
  const normalizedCountry = country.toUpperCase();
  const profiles = COUNTRY_PROFILES[normalizedCountry];
  if (!profiles) {
    throw new Error(
      `Unsupported country ${normalizedCountry}. Supported countries: ${supportedCountries().join(", ")}.`
    );
  }
  const profile = select(profiles);
  const displayName = generateDisplayName(profile);
  const slug = slugify(displayName, profile.language);
  if (slug.length === 0) throw new Error("Pseudonym could not be converted to an email-safe ID.");
  const suffix = uniqueSuffix();
  return {
    country: normalizedCountry,
    displayName,
    email: `${slug.replace(/-/g, ".")}.${suffix}@${emailDomain}`,
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
