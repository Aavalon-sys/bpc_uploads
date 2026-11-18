#!/usr/bin/env node
// Writes the text of a release (Markdown, to standard output) for the packages
// of one build: what they are, and what upstream changed most recently.
//
//   node tools/release-notes.mjs [--build <safari-build.json>] [--zip <chrome zip>] [--repo <owner/name>]
//
// Run after safari/build.mjs. The "Safari extension" workflow publishes the
// result with the packages (see its release job).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_FIXES } from '../safari/build.mjs';
import { CHROME_ZIP, chromeRelease } from './sync-upstream.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function releaseNotes({ build, zip = path.join(repo, CHROME_ZIP), repository = '' } = {}) {
  const { version, changelog } = chromeRelease(zip);
  if (build.version !== version) throw new Error(`the build is of ${build.version}, the Chrome zip of ${version}`);
  const number = /^\d+(\.\d+){0,2}$/.test(build.build.number) ? build.build.number : '?';
  const commit = /^[0-9a-f]{7,40}$/.test(build.build.commit || '') ? build.build.commit.slice(0, 7) : null;
  const readme = repository ? `https://github.com/${repository}/blob/main/safari/README.md` : 'safari/README.md';
  const lines = [
    `对应上游 Bypass Paywalls Clean **${version}**。Safari 构建号 ${number}${commit ? `，提交 ${commit}` : ''}。`,
    '',
    '| 文件 | 用途 |',
    '| --- | --- |',
    '| `Bypass-Paywalls-Clean-macOS.zip` | macOS 的 Safari |',
    '| `Bypass-Paywalls-Clean-unsigned.ipa` | iPhone / iPad 的 Safari（未签名，需要自己签名后安装） |',
    `| \`bypass-paywalls-chrome-clean-${version}-fixed.zip\` | Chrome：上游原版加上本仓库的网站修正 |`,
    `| \`bypass-paywalls-clean-safari-${version}.zip\` | Safari 扩展目录（临时加载，或自己用 Xcode 打包） |`,
    '| `Bypass-Paywalls-Clean-Xcode-project.zip` | 生成好的 Xcode 工程（用自己的账号签名） |',
    '',
    `安装和更新的步骤见 [safari/README.md](${readme})。`,
    '',
    `本仓库额外修正的网站：${SITE_FIXES.map((f) => f.site).join('、') || '无'}。`,
  ];
  // Upstream's text goes in a code block: nothing in it is a link, a mention or markup.
  if (changelog.length) lines.push('', '上游更新日志里最新的一段：', '', '```text', ...changelog, '```');
  return lines.join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  try {
    const build = JSON.parse(fs.readFileSync(args.build || path.join(repo, 'build', 'safari', 'extension', 'safari-build.json'), 'utf8'));
    process.stdout.write(releaseNotes({ build, zip: args.zip, repository: /^[\w.-]+\/[\w.-]+$/.test(args.repo || '') ? args.repo : '' }));
  } catch (e) {
    console.error(`release notes failed: ${e.message}`);
    process.exit(1);
  }
}
