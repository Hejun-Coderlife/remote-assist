/**
 * 下载并解压本机 Python 运行时 + cloudflared，供打安装包使用。
 * 在「项目根目录」执行：node scripts/prepare-bundle.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ASSIST = path.join(ROOT, 'assist-bundle');
const REQ = path.join(ASSIST, 'requirements.txt');

const PYTHON_RELEASE = '20260510';
const PYTHON_WIN_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/cpython-3.12.13%2B${PYTHON_RELEASE}-x86_64-pc-windows-msvc-install_only.tar.gz`;
const PYTHON_MAC_ARM_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/cpython-3.12.13%2B${PYTHON_RELEASE}-aarch64-apple-darwin-install_only.tar.gz`;
const PYTHON_MAC_X64_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}/cpython-3.12.13%2B${PYTHON_RELEASE}-x86_64-apple-darwin-install_only.tar.gz`;

const CF_TAG = '2026.3.0';
const CF_WIN_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CF_TAG}/cloudflared-windows-amd64.exe`;
const CF_MAC_ARM_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CF_TAG}/cloudflared-darwin-arm64.tgz`;
const CF_MAC_X64_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CF_TAG}/cloudflared-darwin-amd64.tgz`;

const CFST_TAG = 'v2.3.4';
const CFST_WIN_ZIP = `https://github.com/XIU2/CloudflareSpeedTest/releases/download/${CFST_TAG}/cfst_windows_amd64.zip`;
const CFST_MAC_ARM_ZIP = `https://github.com/XIU2/CloudflareSpeedTest/releases/download/${CFST_TAG}/cfst_darwin_arm64.zip`;
const CFST_MAC_X64_ZIP = `https://github.com/XIU2/CloudflareSpeedTest/releases/download/${CFST_TAG}/cfst_darwin_amd64.zip`;

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          file.close();
          fs.unlinkSync(dest);
          download(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          try {
            fs.unlinkSync(dest);
          } catch {
            // ignore
          }
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', (err) => {
        try {
          file.close();
          fs.unlinkSync(dest);
        } catch {
          // ignore
        }
        reject(err);
      });
  });
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function walkFindFile(root, names) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (names.includes(e.name)) return full;
    }
  }
  return null;
}

function extractTarGz(archive, outDir) {
  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('tar', ['-xzf', archive, '-C', outDir], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', outDir], { stdio: 'inherit' });
  }
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function extractZip(archive, outDir) {
  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath ${psQuote(archive)} -DestinationPath ${psQuote(outDir)} -Force`
      ],
      { stdio: 'inherit' }
    );
  } else {
    execFileSync('unzip', ['-o', archive, '-d', outDir], { stdio: 'inherit' });
  }
}

function copyCfstBundle(extractRoot, destDir) {
  rmrf(destDir);
  fs.mkdirSync(destDir, { recursive: true });
  const exeNames =
    process.platform === 'win32' ? ['cfst.exe', 'CloudflareST.exe'] : ['cfst', 'CloudflareST'];
  const exe = walkFindFile(extractRoot, exeNames);
  if (!exe) throw new Error('CloudflareSpeedTest 解压后找不到可执行文件');
  const destExe = path.join(destDir, process.platform === 'win32' ? 'cfst.exe' : 'cfst');
  fs.copyFileSync(exe, destExe);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(destExe, 0o755);
    } catch {
      // ignore
    }
  }
  const ipTxt = walkFindFile(extractRoot, ['ip.txt']);
  if (ipTxt) fs.copyFileSync(ipTxt, path.join(destDir, 'ip.txt'));
  const ip6 = walkFindFile(extractRoot, ['ipv6.txt']);
  if (ip6) fs.copyFileSync(ip6, path.join(destDir, 'ipv6.txt'));
}

async function prepareCfstWindows(outBase, cache) {
  const zipPath = path.join(cache, 'cfst-windows.zip');
  const extractTmp = path.join(cache, 'cfst-win-extract');
  console.log('下载 CloudflareSpeedTest（用于国内网络优选 IP）…');
  await download(CFST_WIN_ZIP, zipPath);
  extractZip(zipPath, extractTmp);
  const destDir = path.join(outBase, 'cfst');
  copyCfstBundle(extractTmp, destDir);
  rmrf(extractTmp);
  console.log('CloudflareSpeedTest 已放入:', destDir);
}

async function prepareCfstMac(outBase, cache, arch) {
  const url = arch === 'arm64' ? CFST_MAC_ARM_ZIP : CFST_MAC_X64_ZIP;
  const zipPath = path.join(cache, `cfst-mac-${arch}.zip`);
  const extractTmp = path.join(cache, `cfst-mac-extract-${arch}`);
  console.log('下载 CloudflareSpeedTest（用于优选 IP）…');
  await download(url, zipPath);
  extractZip(zipPath, extractTmp);
  const destDir = path.join(outBase, 'cfst');
  copyCfstBundle(extractTmp, destDir);
  rmrf(extractTmp);
  console.log('CloudflareSpeedTest 已放入:', destDir);
}

function copyPythonTree(extractRoot, destRuntime) {
  const entries = fs.readdirSync(extractRoot).filter((e) => !e.startsWith('.'));
  if (!entries.length) throw new Error('解压目录为空');
  const top = path.join(extractRoot, entries[0]);
  if (!fs.statSync(top).isDirectory()) throw new Error('压缩包结构不符合预期');
  rmrf(destRuntime);
  fs.mkdirSync(path.dirname(destRuntime), { recursive: true });
  fs.cpSync(top, destRuntime, { recursive: true });
  const names =
    process.platform === 'win32'
      ? ['python.exe']
      : ['python3.12', 'python3.11', 'python3.10', 'python3'];
  const py = walkFindFile(destRuntime, names);
  if (!py) throw new Error('复制后找不到 Python 可执行文件');
  return py;
}

function pipInstall(pythonExe) {
  execFileSync(pythonExe, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
    stdio: 'inherit',
    cwd: ROOT
  });
  execFileSync(pythonExe, ['-m', 'pip', 'install', '-r', REQ], {
    stdio: 'inherit',
    cwd: ROOT
  });
}

async function prepareWindows() {
  const outBase = path.join(ROOT, 'bundled-runtime', 'win');
  const cache = path.join(ROOT, 'bundled-runtime', '.cache');
  const tgz = path.join(cache, 'cpython-win.tar.gz');
  const extractRoot = path.join(cache, 'extract-win');
  const destRt = path.join(outBase, 'python-runtime');

  console.log('下载 Windows 版 Python…');
  await download(PYTHON_WIN_URL, tgz);
  console.log('解压…');
  rmrf(extractRoot);
  fs.mkdirSync(extractRoot, { recursive: true });
  extractTarGz(tgz, extractRoot);
  console.log('整理 Python 目录并安装依赖（可能需要几分钟）…');
  const py = copyPythonTree(extractRoot, destRt);
  pipInstall(py);

  const cfDest = path.join(outBase, 'cloudflared.exe');
  console.log('下载 cloudflared…');
  try {
    await download(CF_WIN_URL, cfDest);
  } catch (e) {
    const ok =
      fs.existsSync(cfDest) && fs.statSync(cfDest).size > 512 * 1024;
    if (ok) {
      console.warn('cloudflared 下载失败，已保留现有文件:', e.message || e);
    } else {
      throw e;
    }
  }
  await prepareCfstWindows(outBase, cache);
  console.log('Windows 运行库准备完成:', outBase);
}

function extractCloudflaredMac(tgz, destBin) {
  const tmp = path.join(ROOT, 'bundled-runtime', '.cache', 'cf-mac');
  rmrf(tmp);
  fs.mkdirSync(tmp, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', tmp], { stdio: 'inherit' });
  const found = walkFindFile(tmp, ['cloudflared']);
  if (!found) throw new Error('cloudflared 解压失败');
  fs.copyFileSync(found, destBin);
  try {
    fs.chmodSync(destBin, 0o755);
  } catch {
    // ignore
  }
}

async function prepareMac() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const pyUrl = arch === 'arm64' ? PYTHON_MAC_ARM_URL : PYTHON_MAC_X64_URL;
  const cfUrl = arch === 'arm64' ? CF_MAC_ARM_URL : CF_MAC_X64_URL;

  const outBase = path.join(ROOT, 'bundled-runtime', 'mac');
  const cache = path.join(ROOT, 'bundled-runtime', '.cache');
  const tgz = path.join(cache, `cpython-mac-${arch}.tar.gz`);
  const extractRoot = path.join(cache, `extract-mac-${arch}`);
  const destRt = path.join(outBase, 'python-runtime');

  console.log('下载 macOS 版 Python…');
  await download(pyUrl, tgz);
  console.log('解压…');
  rmrf(extractRoot);
  fs.mkdirSync(extractRoot, { recursive: true });
  extractTarGz(tgz, extractRoot);
  console.log('整理 Python 目录并安装依赖…');
  const py = copyPythonTree(extractRoot, destRt);
  pipInstall(py);

  const cftgz = path.join(cache, `cloudflared-mac-${arch}.tgz`);
  const cfDest = path.join(outBase, 'cloudflared');
  console.log('下载 cloudflared…');
  try {
    await download(cfUrl, cftgz);
    extractCloudflaredMac(cftgz, cfDest);
  } catch (e) {
    const ok = fs.existsSync(cfDest) && fs.statSync(cfDest).size > 512 * 1024;
    if (ok) {
      console.warn('cloudflared 下载失败，已保留现有文件:', e.message || e);
    } else {
      throw e;
    }
  }
  await prepareCfstMac(outBase, cache, arch);
  console.log('macOS 运行库准备完成:', outBase);
}

async function main() {
  if (!fs.existsSync(REQ)) {
    console.error('缺少 assist-bundle/requirements.txt，请先放好协助端代码。');
    process.exit(1);
  }
  const cache = path.join(ROOT, 'bundled-runtime', '.cache');
  if (process.argv.includes('--cfst-only')) {
    if (process.platform === 'win32') {
      const outBase = path.join(ROOT, 'bundled-runtime', 'win');
      await prepareCfstWindows(outBase, cache);
    } else if (process.platform === 'darwin') {
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const outBase = path.join(ROOT, 'bundled-runtime', 'mac');
      await prepareCfstMac(outBase, cache, arch);
    } else {
      console.error('仅支持在 Windows 或 macOS 上执行 --cfst-only。');
      process.exit(1);
    }
    console.log('CloudflareSpeedTest（cfst）已就绪。');
    return;
  }
  if (process.platform === 'win32') {
    await prepareWindows();
  } else if (process.platform === 'darwin') {
    await prepareMac();
  } else {
    console.error('当前系统暂不支持自动准备运行库，请在 Windows 或 macOS 上执行本脚本。');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
