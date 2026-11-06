/**
 * World save files: one JSON document, written atomically (temp file + rename)
 * so a crash mid-save never leaves a truncated world behind.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { World } from './world.js';

/**
 * Save `world` to `file`.
 * @param {string} file Absolute or relative path to world.json.
 * @param {World} world
 */
export async function saveWorld(file, world) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(world.toJSON()), { mode: 0o600 });
  await fs.rename(tmp, file);
}

/**
 * Load a world, or return null when no save exists. A corrupt save is moved
 * aside (never deleted) and null is returned, so the server can start fresh.
 * @param {string} file
 * @param {object} opts World constructor options (now, random, offlineShield, config).
 * @param {(msg:string) => void} [log]
 * @returns {Promise<World|null>}
 */
export async function loadWorld(file, opts, log = () => {}) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const data = JSON.parse(text);
    if (data.version !== 1) throw new Error(`unsupported save version ${data.version}`);
    return World.fromJSON(data, opts);
  } catch (err) {
    const aside = `${file}.corrupt-${Date.now()}`;
    await fs.rename(file, aside);
    log(`Save file unreadable (${err.message}); moved to ${aside}. Starting a new world.`);
    return null;
  }
}
