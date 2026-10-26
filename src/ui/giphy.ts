/** Public GIPHY client key, set at build time (VITE_GIPHY_API_KEY). Empty: no GIF search. */
export const GIPHY_KEY: string = (import.meta.env.VITE_GIPHY_API_KEY as string | undefined) ?? "";
