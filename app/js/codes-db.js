import { CAR_NOTES, CODE_DB_META, CODES } from "../data/codes.js";

export { CAR_NOTES, CODE_DB_META, CODES };

export function lookupCode(code) {
  const key = String(code).toUpperCase();
  const hit = CODES[key];
  const note = CAR_NOTES[key] || "";
  if (!hit) {
    return {
      code: key,
      description: "Unknown code — not in database",
      category: "",
      note,
      known: false,
    };
  }
  return { code: hit.code, description: hit.description, category: hit.category, note, known: true };
}
