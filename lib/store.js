import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MongoClient } from 'mongodb';
export const fail = (status, message) => Object.assign(new Error(message), { status });
export function validateId(id) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw fail(400, 'Invalid project ID.'); return id; }
export function authorize(project, token) {
  if (!project || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(project.tokenHash || '')) throw fail(403, 'Project access denied.');
  const hash = createHash('sha256').update(token).digest();
  if (!timingSafeEqual(hash, Buffer.from(project.tokenHash, 'hex'))) throw fail(403, 'Project access denied.');
}
export function newProject(files) {
  const token = randomBytes(32).toString('base64url');
  return { token, project: { projectId: randomUUID(), tokenHash: createHash('sha256').update(token).digest('hex'), revision: 1, files, updatedAt: new Date().toISOString() } };
}
export class FileStore {
  constructor(directory) { this.directory = path.resolve(directory); }
  async init() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); }
  filename(id) { return path.join(this.directory, `${validateId(id)}.json`); }
  async get(id) { try { return JSON.parse(await readFile(this.filename(id), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  async create(project) { await writeFile(this.filename(project.projectId), JSON.stringify(project), { mode: 0o600, flag: 'wx' }); }
  async save(project, revision) {
    const current = await this.get(project.projectId);
    if (current?.revision !== revision) throw fail(409, 'Project changed. Export local changes before reloading.');
    const next = { ...project, revision: revision + 1, updatedAt: new Date().toISOString() };
    const filename = this.filename(project.projectId), temp = `${filename}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); await rename(temp, filename); }
    finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return next.revision;
  }
  async delete(id, revision) { if ((await this.get(id))?.revision !== revision) throw fail(409, 'Project changed.'); await unlink(this.filename(id)); }
  async close() {}
}
export class MongoStore {
  constructor(uri) { this.client = new MongoClient(uri); }
  async init() { await this.client.connect(); this.collection = this.client.db().collection('ideWorkspaces'); await this.collection.createIndex({ projectId: 1 }, { unique: true }); }
  get(id) { return this.collection.findOne({ projectId: validateId(id) }); }
  create(project) { return this.collection.insertOne(project); }
  async save(project, revision) {
    const { _id, ...next } = project;
    const result = await this.collection.replaceOne({ projectId: project.projectId, revision }, { ...next, revision: revision + 1, updatedAt: new Date().toISOString() });
    if (!result.matchedCount) throw fail(409, 'Project changed. Export local changes before reloading.');
    return revision + 1;
  }
  async delete(id, revision) { if (!(await this.collection.deleteOne({ projectId: id, revision })).deletedCount) throw fail(409, 'Project changed.'); }
  close() { return this.client.close(); }
}
