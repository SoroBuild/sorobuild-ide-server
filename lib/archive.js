import JSZip from 'jszip';
import { validatePath, validateFiles, MAX_BYTES, MAX_FILES } from './workspace.js';
export async function decodeArchive(buffer) {
  if (buffer.length > 8 * 1024 * 1024) throw new Error('ZIP exceeds 8 MiB.');
  const zip = await JSZip.loadAsync(buffer), entries = Object.values(zip.files), files = {};
  if (entries.length > MAX_FILES * 2) throw new Error('Too many ZIP entries.');
  let size = 0;
  for (const entry of entries) {
    validatePath((entry.unsafeOriginalName || entry.name).replace(/\/$/, ''));
    if ((entry.unixPermissions & 0o170000) === 0o120000) throw new Error('ZIP symlinks are not supported.');
    if (entry.dir) continue;
    const chunks = [];
    await new Promise((resolve, reject) => {
      const stream = entry.nodeStream('nodebuffer');
      stream.on('data', chunk => { size += chunk.length; if (size > MAX_BYTES) { stream.pause(); stream.destroy(); reject(new Error('Expanded ZIP exceeds 4 MiB.')); } else chunks.push(chunk); });
      stream.on('error', reject); stream.on('end', resolve);
    });
    files[entry.name] = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  }
  return validateFiles(files);
}
export async function encodeArchive(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(validateFiles(files))) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
