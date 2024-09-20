#!/usr/bin/env node

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { Taskl, Task, TasklOptions } from 'taskl';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const ANSI_COLORS = {
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m'
};

interface ByulConfig {
  language: string;
  model: string;
  commitTypes?: Record<string, string>;
}

function getByulConfig(): ByulConfig {
  try {
    const configPath = path.join(process.cwd(), 'byul.config.json');
    const configFile = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(configFile);
  } catch (error) {
    console.warn(`${ANSI_COLORS.yellow}Warning: Could not read byul.config.json file. Using default settings.${ANSI_COLORS.reset}`);
    return { language: 'English', model: 'gpt-4o-mini' };
  }
}

async function analyzeChanges(diff: string): Promise<string> {
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'dist/analyze_changes.txt'), 'utf8');
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt.replace('${diff}', diff) }],
    max_tokens: 500,
    temperature: 0.7,
  });
  return response.choices[0]?.message?.content?.trim() || '';
}

async function extractIssueNumber(branchName: string): Promise<string> {
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'dist/extract_issue_number.txt'), 'utf8');
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt.replace('${branchName}', branchName) }],
    max_tokens: 50,
    temperature: 0.3,
  });
  return response.choices[0]?.message?.content?.trim() || '';
}

async function generateInitialCommitMessage(summary: string, issueNumber: string, config: ByulConfig): Promise<string> {
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'dist/generate_commit_msg.txt'), 'utf8');
  const commitTypesString = Object.entries(config.commitTypes || {})
    .map(([type, description]) => `- ${type}: ${description}`)
    .join('\n');
  const filledPrompt = prompt
    .replace('${summary}', summary)
    .replace('${issueNumber}', issueNumber)
    .replace('${language}', config.language)
    .replace('${commitTypes}', commitTypesString);
  const response = await openai.chat.completions.create({
    model: config.model,
    messages: [{ role: 'user', content: filledPrompt }],
    max_tokens: 200,
    temperature: 0.6,
  });
  return response.choices[0]?.message?.content?.trim() || '';
}

async function validateCommitMessage(commitMessage: string, issueNumber: string, branchName: string, config: ByulConfig): Promise<string> {
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'dist/validate_commit_msg.txt'), 'utf8');
  const filledPrompt = prompt
    .replace('${commitMessage}', commitMessage)
    .replace('${issueNumber}', issueNumber)
    .replace('${branchName}', branchName)
    .replace('${language}', config.language);
  const response = await openai.chat.completions.create({
    model: config.model,
    messages: [{ role: 'user', content: filledPrompt }],
    max_tokens: 200,
    temperature: 0.3,
  });
  return response.choices[0]?.message?.content?.trim() || '';
}

async function generateCommitMessage(commitMsgFile: string): Promise<void> {
  let config: ByulConfig;
  let changesSummary: string;
  let issueNumber: string;
  let commitMessage: string;

  const tasks: Task[] = [
    {
      text: 'Loading configuration',
      run: async () => {
        config = getByulConfig();
      }
    },
    {
      text: 'Analyzing staged changes',
      run: async () => {
        const diff = await getDiffStream(':(exclude)node_modules');
        changesSummary = await analyzeChanges(diff);
      }
    },
    {
      text: 'Extracting issue number',
      run: async () => {
        const branchName = await getBranchName();
        issueNumber = await extractIssueNumber(branchName);
      }
    },
    {
      text: 'Generating commit message',
      run: async () => {
        commitMessage = await generateInitialCommitMessage(changesSummary, issueNumber, config);
      }
    },
    {
      text: 'Updating commit message file',
      run: async () => {
        const existingMessage = fs.readFileSync(commitMsgFile, 'utf8');
        const combinedMessage = `${commitMessage}\n\n# byul generated commit message. Modify as needed.\n\n${existingMessage}`;
        fs.writeFileSync(commitMsgFile, combinedMessage, 'utf8');
      }
    }
  ];

  const options: TasklOptions = {
    tasks: tasks,
    startMessage: '🔄 Starting byul - Developed by love1ace',
    successMessage: 'byul has generated the commit message.',
    failedMessage: 'byul encountered an error while generating the commit message.'
  };

  const taskl = new Taskl(options);
  await taskl.runTasks();
}

function getDiffStream(excludePattern: string = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const git = spawn('git', ['diff', '--cached', excludePattern]);
    let diff = '';

    git.stdout.on('data', (data) => {
      diff += data.toString();
    });

    git.stderr.on('data', (data) => {
      console.error(`Git error: ${data}`);
    });

    git.on('close', (code) => {
      if (code === 0) {
        resolve(diff);
      } else {
        reject(new Error(`Git process exited with code ${code}`));
      }
    });
  });
}

function getBranchName(): Promise<string> {
  return new Promise((resolve, reject) => {
    const git = spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    let branchName = '';

    git.stdout.on('data', (data) => {
      branchName += data.toString().trim();
    });

    git.on('close', (code) => {
      if (code === 0) {
        resolve(branchName);
      } else {
        reject(new Error(`Git process exited with code ${code}`));
      }
    });
  });
}

const commitMsgFile = process.argv[2];
if (commitMsgFile) {
  generateCommitMessage(commitMsgFile);
} else {
  console.error(`${ANSI_COLORS.red}❌ Error: Commit message file path not provided.${ANSI_COLORS.reset}`);
}