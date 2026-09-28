import { readFile, appendFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Create a JSONL append-only storage.
 *
 * @param {Object} options
 * @param {string} options.path - Path to the .jsonl file
 * @param {number} [options.maxEntries=200] - Maximum entries before compaction
 * @returns {{ load(): Promise<Array>, append(entry): Promise<void>, compact(entries): Promise<void>, clear(): Promise<void> }}
 */
export const createStorage = ({ path, maxEntries = 200 }) => {
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
      return data
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  };

  const append = async (entry) => {
    await ensureDir();
    await appendFile(path, JSON.stringify(entry) + "\n");
  };

  const compact = async (entries) => {
    await ensureDir();
    const data = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(path, data);
  };

  const clear = async () => {
    await ensureDir();
    await writeFile(path, "");
  };

  return { load, append, compact, clear, maxEntries };
};
