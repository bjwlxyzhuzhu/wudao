import { resolve } from 'node:path';
import { createApp } from '../server.js';

process.env.DANCE_HOME = '1';
const app = createApp({ dataDir: resolve(process.env.DANCE_DATA_DIR || '.local/dance-data') });
const port = Number(process.env.PORT || 8790);
app.server.listen(port, '127.0.0.1', () => console.log(`舞镜智练 http://127.0.0.1:${port}/wujing · 舞安智护 http://127.0.0.1:${port}/wuan`));
let closing = false;
const stop = async () => { if (closing) return; closing = true; await app.close(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
