import { fundTestAccount } from './lib/funding.js';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { authorize, fail, newProject, validateId } from './lib/store.js';
import { validateFiles } from './lib/workspace.js';
import { decodeArchive, encodeArchive } from './lib/archive.js';
import { runJob } from './lib/runner.js';
import { askAssistant } from './lib/assistant.js';

export function createApp({ store, execute = runJob, assistant = askAssistant, origins = ['http://localhost:5173', 'http://127.0.0.1:5173'], maxJobs = 2, language, trustProxy = false, fundAccount = fundTestAccount }  = {}) {
  const app = express(), locks = new Set(); let running = 0;
  app.set('trust proxy', trustProxy);
  app.disable('x-powered-by'); app.use(helmet());
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); if (req.headers.origin && !origins.includes(req.headers.origin)) return next(fail(403, 'Origin is not allowed.')); next(); });
  app.use(cors({ origin: origins, allowedHeaders: ['Content-Type', 'Authorization', 'X-Project-Revision'], exposedHeaders: ['X-Project-Revision'] }));
  app.use(rateLimit({ windowMs: 60000, limit: 120, skip: req => /^\/api\/projects\/[^/]+\/language$/.test(req.path), standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests. Retry shortly.' } }));
  app.use(express.json({ limit: '6mb' }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 2, fieldSize: 512 } }).single('file');
  const inputFiles = async req => { try { return req.file ? await decodeArchive(req.file.buffer) : validateFiles(req.body?.files); } catch (error) { throw fail(400, error.message); } };
  const auth = async (req, _res, next) => { try { validateId(req.params.id); req.project = await store.get(req.params.id); authorize(req.project, req.headers.authorization?.replace(/^Bearer /, '')); next(); } catch (error) { next(error); } };
  const guarded = handler => async (req, res, next) => {
    const id = req.params.id;
    if (locks.has(id)) return next(fail(409, 'A project operation is already running.'));
    locks.add(id);
    try { await handler(req, res); } catch (error) { next(error); } finally { locks.delete(id); }
  };
  const revision = req => { const value = Number(req.headers['x-project-revision']); if (!Number.isSafeInteger(value) || value < 1) throw fail(428, 'Project revision required. Reload the project.'); if (value !== req.project.revision) throw fail(409, 'Project changed. Export local edits before reloading.'); return value; };
  app.post('/api/accounts/fund', rateLimit({windowMs:60000,limit:10,standardHeaders:'draft-7',legacyHeaders:false}), async(req,res)=>res.json(await fundAccount(req.body)));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', runningJobs: running, assistant: Boolean(process.env.AI_MODEL) }));
  app.post(['/api/projects', '/api/projects/upload-zip'], rateLimit({ windowMs: 3600000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }), upload, async (req, res) => {
    const { project, token } = newProject(await inputFiles(req)); await store.create(project);
    res.status(201).set('X-Project-Revision', '1').json({ projectId: project.projectId, projectToken: token, revision: 1 });
  });
  app.get('/api/projects/:id', auth, (req, res) => res.set('X-Project-Revision', String(req.project.revision)).json({ files: req.project.files, revision: req.project.revision }));
  app.get('/api/projects/:id/load', auth, async (req, res) => res.set('X-Project-Revision', String(req.project.revision)).type('application/zip').send(await encodeArchive(req.project.files)));
  app.put(['/api/projects/:id', '/api/projects/upload-zip/:id'], auth, upload, guarded(async (req, res) => {
    const previous = revision(req), files = await inputFiles(req); const next = await store.save({ ...req.project, files }, previous);
    res.set('X-Project-Revision', String(next)).json({ revision: next });
  }));
  for (const action of ['build', 'test', 'format']) app.post(`/api/projects/:id/${action}`, auth, upload, guarded(async (req, res) => {
    revision(req); if (running >= maxJobs) throw fail(429, 'Compiler capacity is full. Retry shortly.');
    const files = await inputFiles(req); running++;
    const streaming = req.headers.accept === 'application/x-ndjson' && !req.file;
    const send = event => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n'); };
    if (streaming) { res.type('application/x-ndjson'); res.set('X-Accel-Buffering', 'no'); res.flushHeaders(); }
    try { const result = await execute(action, { files, manifest: req.body.manifest }, { onOutput: streaming ? text => send({type:'log', text}) : undefined });
      if (streaming) { send({type:'result', result}); res.end(); return; }
      if (action === 'format' && result.success && req.file) res.type('application/zip').send(await encodeArchive(result.files));
      else res.status(result.success ? 200 : 422).json(result);
    } catch (error) {
      if (!streaming) throw error;
      send({type:'error', error: error.status && error.status < 500 ? error.message : 'Build service failed. Retry or check the service logs.'}); res.end();
    } finally { running--; }
  }));
  app.post('/api/projects/:id/language', auth, rateLimit({windowMs:60000,limit:300,standardHeaders:'draft-7',legacyHeaders:false}), async (req,res) => {
    if (!language) throw fail(503,'Rust IntelliSense is not configured.');
    const controller=new AbortController();
    const disconnected=()=>{if(!res.writableEnded)controller.abort();};
    res.once('close',disconnected);
    try {
      const result=await language.request(req.params.id,req.body,{signal:controller.signal});
      if(!controller.signal.aborted)res.json(result);
    } catch(error) {if(!controller.signal.aborted)throw error;}
    finally {res.removeListener('close',disconnected);}
  });
  app.post('/api/projects/:id/assistant', auth, guarded(async (req, res) => {
    await inputFiles(req); if (running >= maxJobs) throw fail(429, 'Service is busy.'); running++;
    try { res.json(await assistant(req.body)); } finally { running--; }
  }));
  app.post('/api/projects/:id/delete', auth, guarded(async (req, res) => { await store.delete(req.params.id, revision(req)); await language?.remove?.(req.params.id); res.json({ success: true }); }));
  app.use((_req, _res, next) => next(fail(404, 'Route not found.')));
  app.use((error, _req, res, _next) => {
    const status = error.status || (error instanceof multer.MulterError ? 413 : 500);
    if (status >= 500) console.error('Request failed:', error.name);
    res.status(status).json({ error: status === 500 ? 'Internal service error. Retry or contact the operator.' : error.message });
  });
  return app;
}
