export interface CountryChoice {
  code: string;
  flag: string;
  name: string;
  display: string;
}

const displayNames = new Intl.DisplayNames(["en"], { type: "region" });

export function countryChoice(code: string): CountryChoice {
  const normalized = code.toUpperCase();
  const name = displayNames.of(normalized) ?? normalized;
  const flag = [...normalized]
    .map((character) => String.fromCodePoint(127_397 + character.charCodeAt(0)))
    .join("");
  return { code: normalized, flag, name, display: `${flag} ${name}` };
}
