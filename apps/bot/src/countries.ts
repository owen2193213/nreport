export interface CountryChoice {
  code: string;
  flag: string;
  name: string;
  display: string;
}

const displayNames = new Intl.DisplayNames(["en"], { type: "region" });

export function countryFlag(code: string): string {
  return [...code.toUpperCase()]
    .map((character) => String.fromCodePoint(127_397 + character.charCodeAt(0)))
    .join("");
}

export function countryChoice(code: string): CountryChoice {
  const normalized = code.toUpperCase();
  const name = displayNames.of(normalized) ?? normalized;
  const flag = countryFlag(normalized);
  return { code: normalized, flag, name, display: `${flag} ${name}` };
}

export function countryDisplay(code: string): string {
  if (code.toUpperCase() === "AUTO") return "✨ Auto — Grok chooses";
  return countryChoice(code).display;
}

export function matchingCountries(
  countries: readonly string[],
  query: string
): Array<{ name: string; value: string }> {
  const normalizedQuery = query.trim().toLocaleLowerCase("en");
  const choices = countries
    .map(countryChoice)
    .filter(
      (country) =>
        normalizedQuery.length === 0 ||
        country.name.toLocaleLowerCase("en").includes(normalizedQuery) ||
        country.code.toLocaleLowerCase("en").includes(normalizedQuery)
    )
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .map((country) => ({ name: country.display, value: country.code }));
  const auto = { name: countryDisplay("AUTO"), value: "AUTO" };
  const includeAuto =
    normalizedQuery.length === 0 ||
    "auto".includes(normalizedQuery) ||
    "grok chooses".includes(normalizedQuery);
  return [...(includeAuto ? [auto] : []), ...choices].slice(0, 25);
}
