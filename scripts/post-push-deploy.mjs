#!/usr/bin/env node

import { createReadStream, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { URL } from 'url';
import { spawn } from 'child_process';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function readGitConfig(key, cwd) {
  try {
    return await run('git', ['config', '--get', key], { cwd });
  } catch {
    return '';
  }
}

async function createArchive(repoRoot) {
  const archivePath = join(tmpdir(), `crucix-deploy-${Date.now()}.tar.gz`);
  await run('git', ['archive', '--format=tar.gz', '-o', archivePath, 'HEAD'], { cwd: repoRoot });
  return archivePath;
}

function uploadArchive(targetUrl, headers, archivePath, timeoutMs) {
  return new Promise(async (resolve, reject) => {
    const url = new URL(targetUrl);
    const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const stat = await fs.stat(archivePath);

    const req = requestImpl({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/gzip',
        'Content-Length': stat.size,
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`deploy webhook failed: ${res.statusCode} ${body}`.trim()));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('deploy webhook timed out')));

    createReadStream(archivePath).pipe(req);
  });
}

async function main() {
  const repoRoot = await run('git', ['rev-parse', '--show-toplevel']);
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  const revision = await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  const deployUrl = (await readGitConfig('crucix.deployUrl', repoRoot)) || process.env.CRUCIX_DEPLOY_URL;
  const deployToken = (await readGitConfig('crucix.deployToken', repoRoot)) || process.env.CRUCIX_DEPLOY_TOKEN;
  const deployBranch = (await readGitConfig('crucix.deployBranch', repoRoot)) || process.env.CRUCIX_DEPLOY_BRANCH || 'master';

  if (!deployUrl || !deployToken) {
    console.log('[DeployHook] skipped: missing crucix.deployUrl or crucix.deployToken');
    return;
  }

  if (branch !== deployBranch) {
    console.log(`[DeployHook] skipped: branch ${branch} does not match ${deployBranch}`);
    return;
  }

  const archivePath = await createArchive(repoRoot);

  try {
    const response = await uploadArchive(
      deployUrl,
      {
        'X-Deploy-Token': deployToken,
        'X-Deploy-Ref': `refs/heads/${branch}`,
        'X-Deploy-Revision': revision,
      },
      archivePath,
      30 * 60 * 1000,
    );

    console.log(`[DeployHook] deployed ${revision}`);
    if (response) console.log(response);
  } finally {
    await fs.rm(archivePath, { force: true });
  }
}

main().catch((error) => {
  console.error(`[DeployHook] ${error.message}`);
  process.exitCode = 1;
});
