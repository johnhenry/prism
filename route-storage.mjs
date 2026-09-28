import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Create a JSON file storage for routes.
 *
 * @param {Object} options
 * @param {string} options.path - Path to the routes.json file
 * @returns {{ load(): Promise<Array>, save(routes: Array): Promise<void> }}
 */
export const createRouteStorage = ({ path }) => {
  let initialized = false;

  const ensureDir = async () => {
    if (initialized) return;
    await mkdir(dirname(path), { recursive: true });
    initialized = true;
  };

  const load = async () => {
    try {
      await ensureDir();
      const data = await readFile(path, "utf-8");
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code === "ENOENT") return [];
      if (err instanceof SyntaxError) return [];
      throw err;
    }
  };

  const save = async (routes) => {
    await ensureDir();
    await writeFile(path, JSON.stringify(routes, null, 2) + "\n");
  };

  return { load, save };
};
