import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EN_DICTIONARY } from "../../src/i18n/en";
import { detectLang, localeFor, saveLang, translate } from "../../src/i18n";

const CYRILLIC = /[Ѐ-ӿ]/;
const PLACEHOLDER = /\{(\w+)\}/g;

function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]).sort();
}

/** Every .ts/.tsx file under src/ (for the coverage guard below). */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Literal keys passed to t("...") anywhere in the source. */
function literalTKeys(files: string[]): Set<string> {
  const keys = new Set<string>();
  const pattern = /\bt\(\s*"((?:[^"\\\n]|\\.)*)"/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(pattern)) keys.add(m[1]);
  }
  return keys;
}

describe("translate", () => {
  it("returns the Bulgarian source unchanged for bg", () => {
    expect(translate("bg", "Контакти")).toBe("Контакти");
  });

  it("returns the English entry for en", () => {
    expect(translate("en", "Контакти")).toBe("Contacts");
  });

  it("falls back to the source text when an English entry is missing", () => {
    expect(translate("en", "Текст без превод")).toBe("Текст без превод");
  });

  it("fills placeholders from vars in both languages", () => {
    expect(translate("bg", "Паролата трябва да е поне {n} символа.", { n: 12 })).toBe(
      "Паролата трябва да е поне 12 символа.",
    );
    expect(translate("en", "Паролата трябва да е поне {n} символа.", { n: 12 })).toBe(
      "The password must be at least 12 characters.",
    );
  });

  it("keeps a placeholder that has no matching var", () => {
    expect(translate("en", "{name} ти звъни: {kind} разговор.", { name: "Иван" })).toBe(
      "Иван is calling you: {kind} call.",
    );
  });
});

describe("detectLang", () => {
  const memory = (value: string | null) => ({ getItem: () => value });

  it("uses a saved valid choice first", () => {
    expect(detectLang(memory("en"), "bg-BG")).toBe("en");
    expect(detectLang(memory("bg"), "en-US")).toBe("bg");
  });

  it("ignores an invalid saved value", () => {
    expect(detectLang(memory("fr"), "bg-BG")).toBe("bg");
  });

  it("uses Bulgarian for a Bulgarian browser and English otherwise", () => {
    expect(detectLang(memory(null), "bg")).toBe("bg");
    expect(detectLang(memory(null), "en-US")).toBe("en");
    expect(detectLang(memory(null), undefined)).toBe("en");
  });

  it("does not throw when storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(detectLang(blocked, "bg-BG")).toBe("bg");
  });

  it("saveLang does not throw when storage is blocked", () => {
    expect(() => saveLang("en")).not.toThrow();
  });
});

describe("locale", () => {
  it("maps each language to a date and time locale", () => {
    expect(localeFor("bg")).toBe("bg-BG");
    expect(localeFor("en")).toBe("en-GB");
  });
});

describe("English dictionary", () => {
  const entries = Object.entries(EN_DICTIONARY);

  it("has no empty values", () => {
    for (const [key, value] of entries) {
      expect(value.trim(), `empty value for "${key}"`).not.toBe("");
    }
  });

  it("keeps the same placeholders in key and value", () => {
    for (const [key, value] of entries) {
      expect(placeholders(value), `placeholders differ for "${key}"`).toEqual(placeholders(key));
    }
  });

  it("contains no Bulgarian (Cyrillic) text in English values", () => {
    for (const [key, value] of entries) {
      expect(CYRILLIC.test(value), `Cyrillic left in English value for "${key}"`).toBe(false);
    }
  });

  it("covers every literal t(\"...\") key used in the UI", () => {
    const uiFiles = [
      ...sourceFiles("src/ui"),
      "src/App.tsx",
    ];
    const missing = [...literalTKeys(uiFiles)].filter((key) => !(key in EN_DICTIONARY));
    expect(missing, "UI strings without an English entry").toEqual([]);
  });
});
