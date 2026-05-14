#!/usr/bin/env node

import { createServer } from 'http';
import { createWriteStream, mkdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);
const port = Number.parseInt(process.env.DEPLOY_WEBHOOK_PORT || '9120', 10);
const webhookToken = process.env.DEPLOY_WEBHOOK_TOKEN || '';
const targetBranch = process.env.DEPLOY_TARGET_BRANCH || 'master';
const deployScript = process.env.DEPLOY_SCRIPT || join(rootDir, 'scripts', 'deploy-server.sh');

if (!webhookToken) {
  console.error('[DeployHook] DEPLOY_WEBHOOK_TOKEN is required');
  process.exit(1);
}

let deployInProgress = false;

function normalizeRef(ref) {
  if (!ref) return '';
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function readToken(req) {
  const bearer = req.headers.authorization;
  if (bearer?.startsWith('Bearer ')) return bearer.slice('Bearer '.length).trim();
  const tokenHeader = req.headers['x-deploy-token'];
  return Array.isArray(tokenHeader) ? tokenHeader[0] : (tokenHeader || '').trim();
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function runDeployment(archivePath, metadata) {
  return new Promise((resolve) => {
    const child = spawn('bash', [deployScript, archivePath], {
      cwd: rootDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('close', (code) => {
      console.log(`[DeployHook] deploy finished code=${code} ref=${metadata.ref} revision=${metadata.revision}`);
      resolve({ code, stdout, stderr });
    });
  });
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      deployInProgress,
      targetBranch,
      rootDir,
    });
  }

  if (req.method !== 'POST' || req.url !== '/deploy') {
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (readToken(req) !== webhookToken) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  if (deployInProgress) {
    return sendJson(res, 409, { error: 'Deployment already in progress' });
  }

  const refHeader = req.headers['x-deploy-ref'];
  const revisionHeader = req.headers['x-deploy-revision'];
  const ref = normalizeRef(Array.isArray(refHeader) ? refHeader[0] : (refHeader || ''));
  const revision = Array.isArray(revisionHeader) ? revisionHeader[0] : (revisionHeader || '');

  if (ref && ref !== targetBranch) {
    return sendJson(res, 202, {
      status: 'ignored',
      reason: `branch ${ref} does not match ${targetBranch}`,
    });
  }

  const archivePath = join(tmpdir(), `crucix-deploy-${Date.now()}.tar.gz`);
  const archiveStream = createWriteStream(archivePath);
  let totalBytes = 0;
  let finished = false;

  const complete = (statusCode, payload) => {
    if (finished) return;
    finished = true;
    sendJson(res, statusCode, payload);
  };

  req.on('data', (chunk) => {
    totalBytes += chunk.length;
    if (totalBytes > 1024 * 1024 * 200) {
      req.destroy(new Error('Payload too large'));
    }
  });

  req.on('error', (error) => {
    archiveStream.destroy();
    try { unlinkSync(archivePath); } catch {}
    if (!finished) complete(500, { error: error.message });
  });

  archiveStream.on('error', (error) => {
    try { unlinkSync(archivePath); } catch {}
    if (!finished) complete(500, { error: error.message });
  });

  archiveStream.on('finish', async () => {
    deployInProgress = true;
    console.log(`[DeployHook] deploy requested ref=${ref || 'unknown'} revision=${revision || 'unknown'} bytes=${totalBytes}`);

    try {
      const result = await runDeployment(archivePath, { ref, revision });
      try { unlinkSync(archivePath); } catch {}

      if (result.code === 0) {
        complete(200, {
          status: 'ok',
          bytes: totalBytes,
          ref,
          revision,
        });
      } else {
        complete(500, {
          error: 'Deployment failed',
          exitCode: result.code,
          stderr: result.stderr.trim().slice(-4000),
        });
      }
    } finally {
      deployInProgress = false;
    }
  });

  req.pipe(archiveStream);
});

mkdirSync(join(rootDir, 'runs'), { recursive: true });

server.listen(port, '0.0.0.0', () => {
  console.log(`[DeployHook] listening on 0.0.0.0:${port}`);
  console.log(`[DeployHook] target branch: ${targetBranch}`);
  console.log(`[DeployHook] deploy script: ${deployScript}`);
});
