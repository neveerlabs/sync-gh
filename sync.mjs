import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';
import chalk from 'chalk';
import readline from 'readline';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VERSION = '1.0.3';

const SCRIPT_ROOT = __dirname;
const CONFIG_PATH = path.join(SCRIPT_ROOT, '.config');
const HOME_DIR = process.env.HOME || '/home/neverlabs';
const TERMUX_DIR = path.join(HOME_DIR, '.termux');
const GITIGNORE_PATH = path.join(TERMUX_DIR, '.sync-gitignore');
const GITHUB_OWNER = 'neveerlabs';

dotenv.config();

let config = {};
let githubToken = '';
let geminiKey = '';
let projectPath = '';
let projectName = '';
let repoName = '';
let excludes = [];
let allProjects = [];

async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_PATH, 'utf-8');
    config = JSON.parse(data);
    githubToken = config.GITHUB_TOKEN || '';
    geminiKey = config.GEMINI_API_KEY || '';
  } catch {
    config = {};
    githubToken = '';
    geminiKey = '';
  }
  if (!githubToken) {
    console.log(chalk.yellow('GitHub token missing.'));
    githubToken = await askQuestion(chalk.blue('Enter your GitHub token: '));
    config.GITHUB_TOKEN = githubToken;
  }
  if (!geminiKey) {
    const answer = await askQuestion(chalk.blue('Enter your Gemini API key (optional, press Enter to skip): '));
    if (answer) {
      geminiKey = answer.trim();
      config.GEMINI_API_KEY = geminiKey;
    }
  }
  if (config.GITHUB_TOKEN || config.GEMINI_API_KEY) {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    console.log(chalk.green('✓ Config saved to .config'));
  }
}

async function loadGitignore() {
  try {
    await fs.mkdir(TERMUX_DIR, { recursive: true });
    const data = await fs.readFile(GITIGNORE_PATH, 'utf-8');
    const blocks = data.split(/\n\s*\n/).filter(b => b.trim());
    allProjects = blocks.map(block => {
      const lines = block.split('\n').filter(l => l.trim());
      const obj = {};
      lines.forEach(line => {
        const [key, ...rest] = line.split('=');
        if (key && rest.length) {
          obj[key.trim()] = rest.join('=').trim();
        }
      });
      return obj;
    });
  } catch {
    allProjects = [];
  }
}

async function saveGitignore() {
  let content = allProjects.map(p => {
    const lines = [];
    if (p.PROJECT_NAME) lines.push(`PROJECT_NAME=${p.PROJECT_NAME}`);
    if (p.PROJECT_PATH) lines.push(`PROJECT_PATH=${p.PROJECT_PATH}`);
    if (p.REPO_NAME) lines.push(`REPO_NAME=${p.REPO_NAME}`);
    if (p.EXCLUDES) lines.push(`EXCLUDES=${p.EXCLUDES}`);
    return lines.join('\n');
  }).join('\n\n');
  await fs.writeFile(GITIGNORE_PATH, content, 'utf-8');
}

function findProject(path) {
  return allProjects.find(p => p.PROJECT_PATH === path);
}

function getProjectNameFromPath(path) {
  return path.split('/').pop();
}

async function ensureProject() {
  projectPath = path.dirname(SCRIPT_ROOT);
  projectName = getProjectNameFromPath(projectPath);

  let proj = findProject(projectPath);
  if (!proj) {
    const defaultExcludes = 'node_modules,package-lock.json,sync-gh,.cache,__pycache__,.git,*.log';
    proj = {
      PROJECT_NAME: projectName,
      PROJECT_PATH: projectPath,
      REPO_NAME: projectName,
      EXCLUDES: defaultExcludes
    };
    allProjects.push(proj);
    await saveGitignore();
    console.log(chalk.green(`✓ New project "${projectName}" added to .sync-gitignore`));
  }

  projectName = proj.PROJECT_NAME || projectName;
  repoName = proj.REPO_NAME || projectName;
  excludes = (proj.EXCLUDES || '').split(',').map(e => e.trim()).filter(e => e);
}

async function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans.trim());
  }));
}

function askQuestionRaw(query) {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(query, ans => {
      rl.close();
      resolve(ans.toLowerCase().trim());
    });
  });
}

function showMenu() {
  return new Promise((resolve) => {
    const menuItems = [
      { label: 'Start Repository Sync', value: 'sync' },
      { label: 'Sync with Exclusions', value: 'sync_exclude' },
      { label: 'View Excluded Items', value: 'view_excludes' },
      { label: 'Add to Exclusions', value: 'add_exclude' },
      { label: 'Remove from Exclusions', value: 'remove_exclude' },
      { label: 'Set Repository Name', value: 'set_repo' },
      { label: 'View Current Settings', value: 'view_settings' },
      { label: 'Exit', value: 'exit' }
    ];

    let currentIndex = 0;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const renderMenu = () => {
      console.clear();
      console.log(chalk.cyan(`\n  ${projectName} - Sync Repository`));
      console.log(chalk.gray('─'.repeat(45)));

      menuItems.forEach((item, idx) => {
        const prefix = idx === currentIndex ? chalk.green('▶') : ' ';
        const label = idx === currentIndex ? chalk.white.bold(item.label) : chalk.gray(item.label);
        console.log(`  ${prefix} ${label}`);
      });

      console.log(chalk.gray('─'.repeat(45)));
      console.log(chalk.gray('  ↑/↓ Navigate  •  Enter Select'));
    };

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      rl.close();
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const keyHandler = (key) => {
      if (key === '\x1B[A') {
        currentIndex = (currentIndex - 1 + menuItems.length) % menuItems.length;
        renderMenu();
      } else if (key === '\x1B[B') {
        currentIndex = (currentIndex + 1) % menuItems.length;
        renderMenu();
      } else if (key === '\r' || key === '\n') {
        process.stdin.removeListener('data', dataHandler);
        cleanup();
        resolve(menuItems[currentIndex].value);
      } else if (key === '\x03' || key === '\x1B') {
        process.stdin.removeListener('data', dataHandler);
        cleanup();
        resolve('exit');
      }
    };

    const dataHandler = (data) => {
      const key = data.toString();
      keyHandler(key);
    };

    process.stdin.on('data', dataHandler);
    renderMenu();
  });
}

async function getExcludedItems() {
  const proj = findProject(projectPath);
  if (!proj) return [];
  return (proj.EXCLUDES || '').split(',').map(e => e.trim()).filter(e => e);
}

async function addExclusion() {
  const current = await getExcludedItems();
  console.log(chalk.blue(`\nCurrent exclusions: ${current.join(', ') || '(none)'}`));
  const newItem = await askQuestion(chalk.yellow('Enter file/folder to exclude: '));
  if (!newItem) {
    console.log(chalk.gray('Cancelled.'));
    return;
  }
  const updated = [...new Set([...current, newItem.trim()])];
  const proj = findProject(projectPath);
  if (proj) {
    proj.EXCLUDES = updated.join(',');
    await saveGitignore();
    console.log(chalk.green(`✓ "${newItem.trim()}" added to exclusions.`));
  }
  await waitForEnter();
}

async function removeExclusion() {
  const current = await getExcludedItems();
  if (!current.length) {
    console.log(chalk.yellow('No exclusions to remove.'));
    await waitForEnter();
    return;
  }

  console.log(chalk.blue('\nSelect exclusion to remove:'));
  current.forEach((item, idx) => {
    console.log(`  ${idx+1}. ${item}`);
  });
  console.log(chalk.gray('  0. Cancel'));

  const choice = await askQuestion(chalk.yellow('Enter number: '));
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= current.length) {
    console.log(chalk.gray('Cancelled.'));
    await waitForEnter();
    return;
  }

  const removed = current.splice(idx, 1)[0];
  const proj = findProject(projectPath);
  if (proj) {
    proj.EXCLUDES = current.join(',');
    await saveGitignore();
    console.log(chalk.green(`✓ "${removed}" removed from exclusions.`));
  }
  await waitForEnter();
}

async function setRepoName() {
  const proj = findProject(projectPath);
  if (!proj) return;

  console.log(chalk.blue(`\nCurrent repository name: ${proj.REPO_NAME || projectName}`));
  const newName = await askQuestion(chalk.yellow('Enter new repository name (or leave blank to use project name): '));
  if (newName) {
    proj.REPO_NAME = newName.trim();
  } else {
    proj.REPO_NAME = projectName;
  }
  repoName = proj.REPO_NAME;
  await saveGitignore();
  console.log(chalk.green(`✓ Repository name set to: ${repoName}`));
  await waitForEnter();
}

async function viewSettings() {
  const proj = findProject(projectPath);
  if (!proj) {
    console.log(chalk.yellow('No project configuration found.'));
    await waitForEnter();
    return;
  }

  console.log(chalk.cyan('\n  Current Settings'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(chalk.white(`  Project Name    : ${proj.PROJECT_NAME || 'Not set'}`));
  console.log(chalk.white(`  Project Path    : ${proj.PROJECT_PATH}`));
  console.log(chalk.white(`  Repository Name : ${proj.REPO_NAME || projectName}`));
  console.log(chalk.white(`  Exclusions      : ${proj.EXCLUDES || '(none)'}`));
  console.log(chalk.white(`  GitHub Owner    : ${GITHUB_OWNER}`));
  console.log(chalk.gray('─'.repeat(40)));
  await waitForEnter();
}

async function viewExcludes() {
  const items = await getExcludedItems();
  console.log(chalk.blue(`\nExcluded items for ${projectName}:`));
  if (!items.length) {
    console.log(chalk.gray('  (none)'));
  } else {
    items.forEach(item => console.log(chalk.white(`  • ${item}`)));
  }
  await waitForEnter();
}

function waitForEnter() {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(chalk.gray('\nPress Enter to continue...'), () => {
      rl.close();
      resolve();
    });
  });
}

function isSensitiveFile(relativePath) {
  const basename = path.basename(relativePath).toLowerCase();
  const ext = path.extname(relativePath).toLowerCase();
  const sensitiveNames = [
    '.env', '.env.local', '.env.production', '.env.development',
    '.config', 'config.json', 'secrets.json', 'credentials.json',
    '.secret', '.key', '.pem', '.token', 'secret', 'key'
  ];
  for (const name of sensitiveNames) {
    if (basename.includes(name)) return true;
  }
  return false;
}

function maskSensitiveContent(content, filePath) {
  const basename = path.basename(filePath).toLowerCase();
  if (basename === '.config' || basename === 'config.json' || basename === 'secrets.json' || basename === 'credentials.json') {
    try {
      const json = JSON.parse(content);
      const masked = {};
      for (const key in json) {
        if (json.hasOwnProperty(key)) {
          masked[key] = '*';
        }
      }
      return JSON.stringify(masked, null, 2);
    } catch {
    }
  }
  const lines = content.split('\n');
  const masked = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const [key, ...rest] = trimmed.split('=');
      if (key && rest.length) {
        return `${key.trim()}=*`;
      }
    }
    return line;
  });
  return masked.join('\n');
}

async function generateChangeDescription(changes, projectName) {
  if (!geminiKey) {
    console.log(chalk.yellow('⚠ Gemini API key not set. Skipping documentation generation.'));
    return null;
  }

  try {
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    let prompt = `You are a developer documenting code changes for project "${projectName}".\n\n`;
    prompt += `The following files have been changed (added, modified, or deleted) in the latest sync.\n`;
    prompt += `Provide a concise, human‑readable summary of the updates. Mention key modifications, new features, or fixes.\n\n`;

    for (const change of changes) {
      prompt += `File: ${change.path}\n`;
      prompt += `Status: ${change.type}\n`;
      if (change.type === 'modified' || change.type === 'added') {
        const oldSnippet = change.oldContent ? change.oldContent.substring(0, 200) : '(empty)';
        const newSnippet = change.newContent ? change.newContent.substring(0, 200) : '(empty)';
        prompt += `Old content (first 200 chars):\n${oldSnippet}\n`;
        prompt += `New content (first 200 chars):\n${newSnippet}\n`;
      } else if (change.type === 'deleted') {
        const oldSnippet = change.oldContent ? change.oldContent.substring(0, 200) : '(empty)';
        prompt += `Deleted content (first 200 chars):\n${oldSnippet}\n`;
      }
      prompt += '\n';
    }

    prompt += `Generate a short summary (2‑4 sentences) describing the overall changes in this sync.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    return text.trim();
  } catch (error) {
    console.error(chalk.red(`✗ Gemini error: ${error.message}`));
    if (error.response && error.response.status === 429) {
      console.log(chalk.yellow('  Rate limit exceeded. Please wait and try again later.'));
    } else if (error.response && error.response.status === 403) {
      console.log(chalk.yellow('  Access forbidden. Check your API key and permissions.'));
    } else {
      console.log(chalk.yellow('  Check your API key and network connection.'));
    }
    return null;
  }
}

async function updateDocumentation(changeDescription, changedFiles) {
  const docPath = path.join(projectPath, 'documentation.json');
  let docData = { versions: [] };

  try {
    const content = await fs.readFile(docPath, 'utf-8');
    docData = JSON.parse(content);
  } catch {
  }

  const versionNumber = docData.versions.length + 1;
  const newVersion = {
    version: versionNumber,
    timestamp: new Date().toISOString(),
    changes: changeDescription || `Sync #${versionNumber}`,
    files: changedFiles
  };

  docData.versions.push(newVersion);

  await fs.writeFile(docPath, JSON.stringify(docData, null, 2), 'utf-8');
  console.log(chalk.green(`✓ Documentation updated (version ${versionNumber})`));
}

async function syncToGitHub(useExclusions = true) {
  console.log(chalk.blue('\n  Synchronization Started...'));
  console.log(chalk.gray(`  Project: ${projectName}`));
  console.log(chalk.gray(`  Repo: ${GITHUB_OWNER}/${repoName}`));
  console.log(chalk.gray(`  Path: ${projectPath}`));

  let exclusions = [];
  if (useExclusions) {
    exclusions = await getExcludedItems();
    const baseExcludes = ['node_modules', 'package-lock.json', 'sync-gh', '.cache', '__pycache__', '.git', '*.log'];
    exclusions = [...new Set([...exclusions, ...baseExcludes])];
    if (exclusions.length) {
      console.log(chalk.gray(`  Excluding: ${exclusions.join(', ')}`));
    }
  }

  const githubAPI = axios.create({
    baseURL: `https://api.github.com/repos/${GITHUB_OWNER}/${repoName}/contents/`,
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/vnd.github.v3+json',
    },
    timeout: 30000,
  });

  function shouldIgnore(relativePath) {
    if (relativePath === 'documentation.json') return true;
    return exclusions.some(ex => {
      const parts = relativePath.split('/');
      return parts.some(part => part === ex || part.startsWith(ex + '/'));
    });
  }

  async function getAllLocalFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(projectPath, fullPath);
      if (shouldIgnore(relativePath)) continue;
      if (entry.isDirectory()) {
        const subFiles = await getAllLocalFiles(fullPath);
        files.push(...subFiles);
      } else {
        try {
          let content = await fs.readFile(fullPath, 'utf-8');
          if (isSensitiveFile(relativePath)) {
            content = maskSensitiveContent(content, relativePath);
          }
          files.push({ relativePath, content });
        } catch {
          continue;
        }
      }
    }
    return files;
  }

  async function getGitHubFile(relativePath) {
    try {
      const fullPath = relativePath.replace(/\\/g, '/');
      const response = await githubAPI.get(fullPath);
      const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
      return { sha: response.data.sha, content };
    } catch (error) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async function updateGitHubFile(relativePath, content, sha = null, retries = 1) {
    const payload = {
      message: `Sync: Update ${relativePath}`,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      branch: 'main',
    };
    if (sha) payload.sha = sha;
    try {
      await githubAPI.put(relativePath.replace(/\\/g, '/'), payload);
    } catch (error) {
      if (error.response?.status === 409 && retries > 0) {
        console.log(chalk.yellow(`  Conflict on ${relativePath}, retrying...`));
        const remote = await getGitHubFile(relativePath);
        if (remote) {
          return updateGitHubFile(relativePath, content, remote.sha, retries - 1);
        }
      }
      throw error;
    }
  }

  async function deleteGitHubFile(relativePath, sha) {
    await githubAPI.delete(relativePath.replace(/\\/g, '/'), {
      data: {
        message: `Sync: Delete ${relativePath}`,
        sha: sha,
        branch: 'main',
      },
    });
  }

  try {
    const localFiles = await getAllLocalFiles(projectPath);
    const localPaths = new Set(localFiles.map(f => f.relativePath));
    const fileMap = Object.fromEntries(localFiles.map(f => [f.relativePath, f.content]));

    console.log(chalk.green(`✓ Found ${localFiles.length} local files (excluding ignored)`));

    const changes = [];
    let updated = 0, skipped = 0, errors = 0, deleted = 0;

    for (const relPath of localPaths) {
      const content = fileMap[relPath];
      try {
        const remote = await getGitHubFile(relPath);
        if (remote === null) {
          changes.push({ path: relPath, type: 'added', oldContent: null, newContent: content });
          console.log(chalk.yellow(`  + New: ${relPath}`));
          await updateGitHubFile(relPath, content);
          updated++;
          continue;
        }
        if (remote.content !== content) {
          changes.push({ path: relPath, type: 'modified', oldContent: remote.content, newContent: content });
          console.log(chalk.blue(`  ~ Update: ${relPath}`));
          await updateGitHubFile(relPath, content, remote.sha);
          updated++;
        } else {
          console.log(chalk.gray(`  = Skip: ${relPath}`));
          skipped++;
        }
      } catch (error) {
        console.error(chalk.red(`✗ Failed ${relPath}: ${error.message}`));
        errors++;
      }
    }

    if (changes.length > 0 && geminiKey) {
      console.log(chalk.blue('\n  Generating documentation with Gemini...'));
      const description = await generateChangeDescription(changes, projectName);
      if (description) {
        const changedFiles = changes.map(c => c.path);
        await updateDocumentation(description, changedFiles);
        const docPath = path.join(projectPath, 'documentation.json');
        const docContent = await fs.readFile(docPath, 'utf-8');
        const remoteDoc = await getGitHubFile('documentation.json');
        if (remoteDoc) {
          await updateGitHubFile('documentation.json', docContent, remoteDoc.sha);
        } else {
          await updateGitHubFile('documentation.json', docContent);
        }
        console.log(chalk.green('✓ Documentation uploaded to repo.'));
      }
    } else if (changes.length === 0) {
      console.log(chalk.gray('  No changes detected, skipping documentation.'));
    }

    console.log(chalk.green('\n✓ Synchronization complete!'));
    console.log(chalk.blue('  Statistics:'));
    console.log(chalk.green(`    Updated: ${updated}`));
    console.log(chalk.gray(`    Skipped: ${skipped}`));
    if (deleted > 0) console.log(chalk.red(`    Deleted: ${deleted}`));
    if (errors > 0) console.log(chalk.red(`    Errors: ${errors}`));

    const currentRepo = findProject(projectPath)?.REPO_NAME || projectName;
    if (currentRepo !== projectName) {
      const answer = await askQuestionRaw(
        chalk.yellow(`\nRepository name is different from project name.\n  Current repo: ${currentRepo}\n  Project name: ${projectName}\n  Do you want to rename repo to match project name? (y/n): `)
      );
      if (answer === 'y' || answer === 'yes') {
        const proj = findProject(projectPath);
        if (proj) {
          proj.REPO_NAME = projectName;
          repoName = projectName;
          await saveGitignore();
          console.log(chalk.green(`✓ Repository name updated to: ${projectName}`));
        }
      } else {
        console.log(chalk.gray('  Repository name unchanged.'));
      }
    }

  } catch (error) {
    console.error(chalk.red(`✗ Sync failed: ${error.message}`));
  }

  await waitForEnter();
}

function compareVersions(v1, v2) {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const n1 = parts1[i] || 0;
    const n2 = parts2[i] || 0;
    if (n1 !== n2) return n1 - n2;
  }
  return 0;
}

async function checkScriptUpdate() {
  try {
    const scriptRepo = 'neveerlabs/sync-gh';
    const url = `https://raw.githubusercontent.com/${scriptRepo}/main/sync.mjs`;
    const response = await axios.get(url, { timeout: 10000 });
    const remoteContent = response.data;
    const versionMatch = remoteContent.match(/const VERSION\s*=\s*['"]([^'"]+)['"]/);
    if (!versionMatch) {
      console.log(chalk.yellow('Could not determine remote version. Skipping update check.'));
      return false;
    }
    const remoteVersion = versionMatch[1];
    if (compareVersions(remoteVersion, VERSION) > 0) {
      console.log(chalk.yellow(`\nNew version ${remoteVersion} available (current ${VERSION}).`));
      const answer = await askQuestionRaw(chalk.blue('Download and update sync.mjs? (y/n): '));
      if (answer === 'y' || answer === 'yes') {
        console.log(chalk.blue('Downloading new version...'));
        const localPath = path.join(SCRIPT_ROOT, 'sync.mjs');
        await fs.writeFile(localPath, remoteContent, 'utf-8');
        console.log(chalk.green('✓ sync.mjs updated. Restarting...'));
        const child = spawn('node', [localPath], {
          stdio: 'inherit',
          detached: false,
        });
        child.on('error', (err) => {
          console.error(chalk.red(`Failed to start new version: ${err.message}`));
        });
        process.exit(0);
      } else {
        console.log(chalk.gray('Skipping update.'));
      }
    } else {
      console.log(chalk.gray(`Script is up to date (${VERSION}).`));
    }
    return true;
  } catch (error) {
    console.log(chalk.yellow(`Script update check failed: ${error.message}`));
    return false;
  }
}

async function main() {
  try {
    await loadConfig();
    await checkScriptUpdate();
    await loadGitignore();
    await ensureProject();

    while (true) {
      const choice = await showMenu();
      switch (choice) {
        case 'sync':
          await syncToGitHub(true);
          break;
        case 'sync_exclude':
          await syncToGitHub(true);
          break;
        case 'view_excludes':
          await viewExcludes();
          break;
        case 'add_exclude':
          await addExclusion();
          break;
        case 'remove_exclude':
          await removeExclusion();
          break;
        case 'set_repo':
          await setRepoName();
          break;
        case 'view_settings':
          await viewSettings();
          break;
        case 'exit':
          console.log(chalk.green('\nGoodbye!'));
          process.exit(0);
        default:
          break;
      }
    }
  } catch (error) {
    console.error(chalk.red(`✗ Fatal error: ${error.message}`));
    console.error(error.stack);
    process.exit(1);
  }
}

main();
