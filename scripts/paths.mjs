import path from "node:path";
import { fileURLToPath } from "node:url";

export const skillRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
