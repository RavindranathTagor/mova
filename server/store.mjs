import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function createStore({ path = '.data/missions.json', renameFile = rename, wait = delay } = {}) {
  const filename = resolve(path);
  let queue = Promise.resolve();
  return {
    async load() {
      try { return JSON.parse(await readFile(filename, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return { version: 1, currentId: null, missions: [] }; throw error; }
    },
    save(state) {
      const body = JSON.stringify(state, null, 2);
      const task = queue.then(async () => {
        await mkdir(dirname(filename), { recursive: true });
        const temporary = `${filename}.${randomUUID()}.tmp`;
        const file = await open(temporary, 'w', 0o600);
        try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
        try {
          for (let attempt = 0; ; attempt++) {
            try { await renameFile(temporary, filename); break; }
            catch (error) {
              // Windows indexers/scanners can hold a short-lived share lock.
              // Never remove the old checkpoint to work around that lock.
              if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 5) throw error;
              await wait(25 * 2 ** attempt);
            }
          }
        } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}
