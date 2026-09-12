import 'dotenv/config';
import { MongoClient, GridFSBucket } from 'mongodb';
import { writeFile } from 'node:fs/promises';
import { decodeArchive } from './archive.js';
import { newProject, validateId } from './store.js';
if (!process.env.DB_URI || !process.argv[2]) throw new Error('Set DB_URI and supply a new private output filename.');
const client = new MongoClient(process.env.DB_URI); await client.connect();
try {
  const db = client.db(), bucket = new GridFSBucket(db, { bucketName: 'projectZips' }), collection = db.collection('ideWorkspaces');
  await collection.createIndex({ projectId: 1 }, { unique: true });
  const pending = [];
  for await (const record of db.collection('projects').find({ zipFileId: { $exists: true } })) {
    validateId(record.projectId); if (await collection.findOne({ projectId: record.projectId })) continue;
    const chunks = []; let bytes = 0;
    for await (const chunk of bucket.openDownloadStream(record.zipFileId)) { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) throw new Error('Legacy ZIP exceeds upload limit.'); chunks.push(chunk); }
    const item = newProject(await decodeArchive(Buffer.concat(chunks))); item.project.projectId = record.projectId; pending.push(item);
  }
  await writeFile(process.argv[2], JSON.stringify(pending.map(({ project, token }) => ({ projectId: project.projectId, projectToken: token })), null, 2), { mode: 0o600, flag: 'wx' });
  for (const { project } of pending) await collection.insertOne(project);
  console.log(`Migrated ${pending.length} projects. Keep the private token file secure.`);
} finally { await client.close(); }
