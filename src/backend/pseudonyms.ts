import { randomBytes, randomInt } from "node:crypto";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

interface CountryCatalog {
  givenNames: readonly string[];
  familyNames: readonly string[];
  timezone: string;
}

const CATALOGS: Readonly<Record<string, CountryCatalog>> = {
  DE: {
    givenNames: [
      "Anna",
      "Clara",
      "Emilia",
      "Felix",
      "Hannah",
      "Johannes",
      "Lena",
      "Lukas",
      "Matthias",
      "Sophie"
    ],
    familyNames: [
      "Bauer",
      "Fischer",
      "Hoffmann",
      "Klein",
      "Meyer",
      "Müller",
      "Richter",
      "Schneider",
      "Schulz",
      "Weber"
    ],
    timezone: "Europe/Berlin"
  }
};

export interface GeneratedIdentity {
  country: string;
  displayName: string;
  email: string;
  internalReportId: string;
  timezone: string;
}

export function supportedCountries(): string[] {
  return Object.keys(CATALOGS).sort();
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
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

export function createProxySessionId(): string {
  const value = BigInt(`0x${randomBytes(8).toString("hex")}`) % 1_000_000_000_000n;
  return value.toString().padStart(12, "0");
}

export function generateIdentity(country: string, emailDomain: string): GeneratedIdentity {
  const normalizedCountry = country.toUpperCase();
  const catalog = CATALOGS[normalizedCountry];
  if (!catalog) {
    throw new Error(
      `Unsupported country ${normalizedCountry}. Supported countries: ${supportedCountries().join(", ")}.`
    );
  }
  const givenName = catalog.givenNames[randomInt(catalog.givenNames.length)];
  const familyName = catalog.familyNames[randomInt(catalog.familyNames.length)];
  if (!givenName || !familyName) throw new Error("Pseudonym catalog is empty.");
  const displayName = `${givenName} ${familyName}`;
  const slug = slugify(displayName);
  const suffix = uniqueSuffix();
  return {
    country: normalizedCountry,
    displayName,
    email: `${slug.replace(/-/g, ".")}.${suffix}@${emailDomain}`,
    internalReportId: `${slug}-${suffix}`,
    timezone: catalog.timezone
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
