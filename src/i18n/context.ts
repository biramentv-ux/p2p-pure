import { createContext } from "react";
import type { I18n } from "./core";

/** Null outside the provider; useI18n then falls back to the detected language. */
export const I18nContext = createContext<I18n | null>(null);
