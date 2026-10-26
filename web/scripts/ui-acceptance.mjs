/**
 * 工作台浏览器验收（T041）：真实 Runtime + 真实 RPC + Chromium。
 *
 * 覆盖空存档首屏、真实发送、待确认计划、运行状态与控制、思考折叠、长文本内部滚动、
 * 窄屏布局与断连提示；截图保存在验收目录。
 *
 * 用法：node scripts/ui-acceptance.mjs [--out <dir>]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const outIndex = process.argv.indexOf('--out');
const outDir = outIndex >= 0 ? process.argv[outIndex + 1] : mkdtempSync(path.join(tmpdir(), 'cordiswarm-ui-'));
const root = mkdtempSync(path.join(tmpdir(), 'cordiswarm-ui-store-'));
const port = Number(process.env.ACCEPTANCE_PORT ?? 18232);
const base = 'http://127.0.0.1:' + port;

mkdirSync(outDir, { recursive: true });
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(method, params) {
  const response = await fetch(base + '/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  return await response.json();
}

const server = spawn(process.execPath, [path.join(repo, 'runtime', 'dist', 'server.js')], {
  env: {
    ...process.env,
    SWARM_STORE_DIR: path.join(root, 'store'),
    RUNTIME_PORT: String(port),
    CORDISWARM_JOB_WORKSPACE: path.join(root, 'jobs'),
    CORDISWARM_AGENT_WORKSPACE: path.join(root, 'sessions'),
    CORDISWARM_SKILLS_DIR: path.join(root, 'skills'),
    CORDISWARM_MCP_FILE: path.join(root, 'store', 'mcp.json'),
  },
  stdio: 'ignore',
});

async function waitForServer() {
  for (let index = 0; index < 80; index += 1) {
    try {
      const response = await fetch(base + '/health');
      if (response.ok) return true;
    } catch {
      // 继续等待
    }
    await wait(250);
  }
  return false;
}

/** 从隔离 store 取最近创建的会话，供界面刷新后的计划展示使用。 */
function latestSessionId() {
  const file = path.join(root, 'store', 'sessions.json');
  if (!existsSync(file)) return null;
  const sessions = JSON.parse(readFileSync(file, 'utf8'));
  return sessions.length > 0 ? sessions[sessions.length - 1].id : null;
}

/** 真实课题：数据由公式生成，训练脚本真实执行并写出评估文件。 */
function seedTopic() {
  const datasetDir = path.join(root, 'topic');
  mkdirSync(datasetDir, { recursive: true });
  const dataset = path.join(datasetDir, 'dataset.csv');
  const weights = path.join(datasetDir, 'weights.bin');
  const rows = ['x,y'];
  for (let index = 0; index < 240; index += 1) {
    const x = (index % 60) / 20 - 1.5;
    rows.push(x.toFixed(3) + ',' + (x > 0 ? 1 : 0));
  }
  writeFileSync(dataset, rows.join('\n'), 'utf8');
  writeFileSync(weights, 'seed', 'utf8');

  const workspace = path.join(root, 'jobs', 'run-ui-e2e');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, 'train.mjs'), [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const mode = args[args.indexOf('--mode') + 1] ?? 'baseline';",
    "const rows = readFileSync(process.env.CORDISWARM_DATASET, 'utf8').trim().split('\\n').slice(1).map((line) => line.split(',').map(Number));",
    "const lr = mode === 'compare' ? 0.05 : 0.2;",
    "let w = 0, b = 0;",
    "for (let epoch = 0; epoch < 400; epoch += 1) { let gw = 0, gb = 0; for (const [x, y] of rows) { const p = 1 / (1 + Math.exp(-(w * x + b))); gw += (p - y) * x; gb += p - y; } w -= (lr * gw) / rows.length; b -= (lr * gb) / rows.length; }",
    "let loss = 0, correct = 0;",
    "for (const [x, y] of rows) { const p = 1 / (1 + Math.exp(-(w * x + b))); loss += -(y * Math.log(p + 1e-9) + (1 - y) * Math.log(1 - p + 1e-9)); if ((p > 0.5 ? 1 : 0) === y) correct += 1; }",
    "const penalty = mode === 'ablate' ? 0.4 : 0;",
    "writeFileSync('metrics.json', JSON.stringify({ loss: Number((loss / rows.length + penalty).toFixed(4)), accuracy: Number((correct / rows.length).toFixed(4)) }));",
    "console.log('trained mode=' + mode);",
  ].join('\n'), 'utf8');
  return { dataset, weights };
}

function seedPlan(sessionId) {
  const storeDir = path.join(root, 'store');
  const now = new Date().toISOString();
  const topic = seedTopic();
  const plan = {
    id: 'plan-ui-acceptance',
    teamId: 'team-ui-acceptance',
    sessionId,
    version: 1,
    intentVersion: 1,
    objective: '验证批量大小对逻辑回归损失收敛的影响',
    hypotheses: [{ id: 'h1', statement: '更大的批量会降低梯度噪声', rationale: '知识库命中 R001', sourceRefs: [], status: 'proposed' }],
    experiments: [
      {
        id: 'exp-ui-baseline',
        title: '基线训练',
        purpose: 'baseline',
        datasetRef: topic.dataset,
        modelRef: topic.weights,
        codePath: 'train.mjs',
        evaluationCommand: 'node train.mjs --mode baseline',
        args: ['--mode', 'baseline'],
        metrics: ['loss', 'accuracy'],
      },
      {
        id: 'exp-ui-ablation',
        title: '消融复测',
        purpose: 'ablation',
        datasetRef: topic.dataset,
        modelRef: topic.weights,
        codePath: 'train.mjs',
        evaluationCommand: 'node train.mjs --mode ablate',
        args: ['--mode', 'ablate'],
        metrics: ['loss', 'accuracy'],
      },
    ],
    resourceAssignments: [
      { id: 'ra1', kind: 'dataset', locator: topic.dataset },
      { id: 'ra2', kind: 'weights', locator: topic.weights },
    ],
    evidenceCriteria: ['loss 不高于 0.4', 'accuracy 不低于 0.8'],
    createdAt: now,
    updatedAt: now,
  };
  const approvals = [{
    id: 'approval-plan-ui-acceptance-v1',
    sessionId,
    teamId: plan.teamId,
    kind: 'plan',
    subjectVersion: 1,
    actionDigest: 'ui-acceptance-digest',
    status: 'pending',
    summary: '批准科研计划 v1',
    requestedAt: now,
  }];
  const runs = [{
    id: 'run-ui-e2e',
    teamId: plan.teamId,
    sessionId,
    planId: plan.id,
    planVersion: 1,
    intentVersion: 1,
    version: 1,
    status: 'awaiting_approval',
    stage: 'plan',
    jobRefs: [],
    artifactRefs: [],
    lastAppliedMessageSequence: 0,
    createdAt: now,
    updatedAt: now,
  }];
  const teams = [{
    id: plan.teamId,
    goal: plan.objective,
    status: 'created',
    roles: { explorer: 't1', worker: 't2', validator: 't3' },
    intent: {
      version: 1,
      objective: plan.objective,
      criteria: [
        { id: 'c1', description: '真实指标已记录', weight: 1, required: true, evidenceKey: 'metrics.recorded' },
        { id: 'c2', description: '评估证据完整', weight: 1, required: true, evidenceKey: 'evaluation.complete' },
        { id: 'c3', description: '图稿可编辑', weight: 1, required: true, evidenceKey: 'figures.editable' },
        { id: 'c4', description: '稿件达到投稿准备完成', weight: 1, required: true, evidenceKey: 'submission.ready' },
      ],
      constraints: [],
      evidenceRequirements: ['loss', 'accuracy'],
    },
    createdAt: now,
    updatedAt: now,
  }];
  writeFileSync(path.join(storeDir, 'plans.json'), JSON.stringify([plan], null, 2), 'utf8');
  writeFileSync(path.join(storeDir, 'approvals.json'), JSON.stringify(approvals, null, 2), 'utf8');
  writeFileSync(path.join(storeDir, 'runs.json'), JSON.stringify(runs, null, 2), 'utf8');
  writeFileSync(path.join(storeDir, 'teams.json'), JSON.stringify(teams, null, 2), 'utf8');
  return plan;
}

/** 会话日志路径：会话按工作区分组存放为 sessions/<工作区>/<sessionId>/session.jsonl。 */
function sessionLogPath(sessionId) {
  const dir = path.join(root, 'store', 'sessions');
  if (!existsSync(dir)) return null;
  for (const workspace of readdirSync(dir)) {
    const file = path.join(dir, workspace, sessionId, 'session.jsonl');
    if (existsSync(file)) return file;
  }
  return null;
}

/** 向会话日志追加一条消息记录：首行头部 + 逐行记录，序号在会话内递增。 */
function appendMessage(sessionId, kind, content) {
  const file = sessionLogPath(sessionId);
  if (!file) throw new Error('会话日志不存在：' + sessionId);
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const sequence = records
    .filter((record) => record.record === 'message')
    .reduce((max, record) => Math.max(max, record.sequence), 0) + 1;
  const record = { record: 'message', id: 'seed-' + sequence, sessionId, sequence, kind, content, receivedAt: new Date().toISOString() };
  appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

/** 首页与会话视图的输入框/发送按钮最终一致，这里统一按可见控件操作。 */
async function sendGoal(page, text) {
  const textarea = page.locator('textarea:visible').first();
  await textarea.waitFor({ state: 'visible', timeout: 20000 });
  // 等待上一轮处理结束（正在处理指示消失），再填写并发送
  await page.waitForFunction(() => document.querySelector('.cs-running-line') === null, null, { timeout: 90000 }).catch(() => undefined);
  // 运行事件刷新可能触发重渲染：输入后校验值与按钮状态，必要时重试
  const sendEnabled = () => page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button[aria-label="发送消息"]')].filter((button) => button.offsetParent !== null);
    return buttons.some((button) => !button.disabled);
  });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const target = page.locator('textarea:visible').first();
    await target.click();
    await target.fill('');
    await page.keyboard.type(text, { delay: 5 });
    await wait(250);
    const valueOk = (await target.inputValue()) === text;
    if (valueOk && (await sendEnabled())) {
      await page.locator('button[aria-label="发送消息"]:visible').first().click();
      return;
    }
    await wait(400);
  }
  throw new Error('无法在会话视图中输入并发送：' + text);
}

const browser = await chromium.launch();
const report = { outDir, storeDir: root };

try {
  if (!(await waitForServer())) throw new Error('Runtime 未在预期时间内就绪');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await wait(600);

  // 1) 空存档首屏
  const emptyText = await page.locator('[aria-label="会话"] .cs-empty-tree').innerText().catch(() => '');
  record('空存档首屏显示空会话列表', emptyText.includes('暂无会话'), emptyText.trim());
  const emptyHistory = await page.locator('[aria-label="历史会话"] .cs-empty-tree').innerText().catch(() => '');
  record('空存档首屏历史会话为空', emptyHistory.includes('暂无工作区') || emptyHistory.includes('暂无历史会话'), emptyHistory.trim());
  await page.screenshot({ path: path.join(outDir, '01-empty-store.png') });

  // 1b) 新会话首页 composer 与会话页 composer 提供同一组控件
  const heroControls = await page.evaluate(() => ({
    preset: Boolean(document.querySelector('.cs-composer button[aria-label="Agent 预设"]')),
    access: Boolean(document.querySelector('.cs-composer button[aria-label="访问模式"]')),
    content: Boolean(document.querySelector('.cs-composer button[aria-label="添加内容"]')),
    attachment: Boolean(document.querySelector('.cs-composer button[aria-label="添加附件"]')),
  }))
  record(
    '新会话首页 composer 提供预设、访问模式与添加入口',
    heroControls.preset && heroControls.access && heroControls.content && heroControls.attachment,
    JSON.stringify(heroControls),
  )

  // 2) 真实发送：用户气泡 + 真实错误反馈（无模型服务时不伪造回答）
  await sendGoal(page, '帮我整理一份会议纪要模板');
  await page.waitForSelector('.cs-message-list, .cs-conversation', { timeout: 20000 });
  const bodyAfterSend = await page.locator('body').innerText();
  record('发送后进入会话视图', bodyAfterSend.includes('帮我整理一份会议纪要模板'), '');
  await page.waitForFunction(() => document.body.innerText.includes('模型调用失败') || document.body.innerText.includes('未配置 API Key'), null, { timeout: 60000 })
    .then(() => record('模型不可用时展示真实错误', true))
    .catch(() => record('模型不可用时展示真实错误', false, '未出现真实错误提示'));
  await page.screenshot({ path: path.join(outDir, '02-real-send.png') });

  const sessionId = latestSessionId();
  record('会话已持久化到隔离 store', Boolean(sessionId), String(sessionId));

  // 2b) 右栏任务管理：真实子代理进入集群成员树
  const openedTeam = await rpc('swarm.team.open', { sessionId, name: '主代理' });
  const mainMemberId = openedTeam?.result?.member?.id;
  record('按会话建立集群团队并生成主代理成员', Boolean(mainMemberId), String(mainMemberId));
  const spawnedMember = await rpc('swarm.team.spawn', {
    parentId: mainMemberId,
    name: '会话页规格核查',
    description: '验收子代理',
    resumable: true,
    taskTitle: '核查会话页',
  });
  record('派生子代理创建真实子会话', Boolean(spawnedMember?.result?.session?.id), String(spawnedMember?.result?.session?.id));
  await page.locator('button[aria-label="任务管理"]').first().click();
  // 任务管理面板按真实轮询刷新，等待一个轮询周期后再断言
  await wait(5000);
  const teamPanel = await page.locator('.cs-team-panel').innerText().catch(() => '');
  record(
    '右栏任务管理列出真实子代理与状态',
    teamPanel.includes('会话页规格核查') && teamPanel.includes('1 个子代理') && teamPanel.includes('可续接'),
    teamPanel.replace(/\n/g, ' ').slice(0, 120),
  );
  await page.screenshot({ path: path.join(outDir, '02b-team-cluster.png') });

  // 3) 待确认计划与运行状态
  seedPlan(sessionId);
  appendMessage(sessionId, 'assistant', '<think>内部推理：先检索知识库</think>已形成待确认计划，请审阅。');
  await sendGoal(page, '继续');
  await page.waitForSelector('.plan-review', { timeout: 30000 })
    .then(() => record('待确认计划卡片展示版本与创新候选', true))
    .catch(async () => {
      const text = await page.locator('body').innerText();
      record('待确认计划卡片展示版本与创新候选', false, text.slice(0, 200));
    });
  const planText = await page.locator('.plan-review').innerText().catch(() => '');
  record('计划卡片包含验收标准与审批摘要', planText.includes('loss 不高于 0.4') && planText.includes('ui-acceptanc'), planText.slice(0, 160).replace(/\n/g, ' '));
  await page.screenshot({ path: path.join(outDir, '03-plan-review.png') });

  await page.waitForSelector('.run-bar', { timeout: 20000 })
    .then(() => record('运行状态条展示真实阶段与状态', true))
    .catch(() => record('运行状态条展示真实阶段与状态', false, '未渲染'));
  const runText = await page.locator('.run-bar').innerText().catch(() => '');
  record('运行状态条显示等待批准的运行', runText.includes('awaiting_approval'), runText.split('\n')[0] ?? '');

  // 4) 批准计划后运行推进并展示真实状态
  const reviewed = await rpc('swarm.plan.review', {
    teamId: 'team-ui-acceptance',
    planId: 'plan-ui-acceptance',
    version: 1,
    decision: 'approve',
    clientRequestId: 'ui-acceptance-review',
  });
  record('通过真实 RPC 批准计划', reviewed.ok === true, JSON.stringify(reviewed.result ?? reviewed.error).slice(0, 160));
  // 等待真实运行完成（真实训练 + 图稿编译 + LaTeX 编译 + 投稿校验）
  let snapshot = null;
  for (let index = 0; index < 300; index += 1) {
    const reply = await rpc('swarm.run.get', { runId: 'run-ui-e2e' });
    snapshot = reply.result ?? null;
    if (snapshot && ['completed', 'blocked', 'failed'].includes(snapshot.status)) break;
    await wait(500);
  }
  record('真实课题运行完成到交付阶段', snapshot?.status === 'completed' && snapshot?.stage === 'deliver', JSON.stringify({ status: snapshot?.status, stage: snapshot?.stage, error: snapshot?.error ?? null }).slice(0, 200));
  record('投稿准备状态由真实校验写入', snapshot?.submissionReady === true, String(snapshot?.submissionReady));

  await page.waitForFunction(() => document.querySelector('.run-bar')?.textContent?.includes('completed') ?? false, null, { timeout: 60000 })
    .then(() => record('界面运行状态与后端一致', true))
    .catch(async () => record('界面运行状态与后端一致', false, (await page.locator('.run-bar').innerText().catch(() => '')).slice(0, 120)));
  await page.screenshot({ path: path.join(outDir, '04-run-state.png') });

  // 三个入口一致：CLI 读取同一运行，画布节点展示同一状态
  const cliOutput = execFileSync(process.execPath, [path.join(repo, 'runtime', 'dist', 'server.js'), 'research', 'status', 'run-ui-e2e', '--json', '--url', base], { encoding: 'utf8', timeout: 60000 });
  const cliStatus = JSON.parse(cliOutput);
  record('CLI 与 RPC 对同一运行状态一致', cliStatus.status === snapshot?.status && cliStatus.stage === snapshot?.stage && cliStatus.submissionReady === snapshot?.submissionReady, JSON.stringify({ cli: cliStatus.status, rpc: snapshot?.status }).slice(0, 120));
  const artifacts = await rpc('swarm.run.get', { runId: 'run-ui-e2e' });
  const artifactRefs = artifacts.result?.artifactRefs ?? [];
  record('运行登记图稿、论文与日志产物', artifactRefs.length >= 6, String(artifactRefs.length));

  const canvasStatus = await page.evaluate(async (runId) => {
    const response = await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'swarm.run.get', params: { runId } }) });
    const payload = await response.json();
    return payload.result ?? null;
  }, 'run-ui-e2e');
  record('画布数据源与运行快照同源', canvasStatus?.status === snapshot?.status && canvasStatus?.stage === snapshot?.stage, String(canvasStatus?.status));

  // 5) 思考折叠：思考进入折叠区，正文不含思考标签
  const conversation = await page.evaluate(() => document.body.innerText);
  record('思考内容进入可收缩区域', conversation.includes('已思考'), '');
  record('正文不包含思考标签', !conversation.includes('<think>'), '');

  // 6) 长文本内部滚动，输入区保持可见
  appendMessage(sessionId, 'assistant', '长文本验收：' + '内容'.repeat(2000));
  await sendGoal(page, '长文本');
  await wait(1800);
  const scroll = await page.evaluate(() => {
    const list = document.querySelector('.cs-message-list');
    const composer = document.querySelector('.cs-conversation-composer');
    if (!list || !composer) return null;
    const box = composer.getBoundingClientRect();
    return {
      scrollable: list.scrollHeight > list.clientHeight,
      composerVisible: box.bottom <= window.innerHeight + 1 && box.top >= 0,
      overflowY: getComputedStyle(list).overflowY,
    };
  });
  record('长文本在会话内滚动且输入区可见', Boolean(scroll && scroll.scrollable && scroll.composerVisible && scroll.overflowY === 'auto'), JSON.stringify(scroll));
  await page.screenshot({ path: path.join(outDir, '05-long-text.png') });

  // 7) 历史会话：真实会话日志列表、刷新后回到同一会话、切换与搜索
  await page.locator('.cs-new-session').click();
  await wait(500);
  await sendGoal(page, '整理历史会话验收记录');
  await wait(1500);
  await page.reload({ waitUntil: 'networkidle' });
  await wait(1800);
  // 有会话的分组默认已展开；仅在收起时才点击展开
  const unassignedRow = page.locator('[aria-label="历史会话"] .cs-workspace-row', { hasText: '未归属工作区' }).first();
  if ((await unassignedRow.getAttribute('aria-expanded')) !== 'true') {
    await unassignedRow.click({ timeout: 10000 }).catch(() => undefined);
    await wait(600);
  }
  const historyRows = await page.locator('[aria-label="历史会话"] .cs-session-row').count();
  record('侧栏按工作区分组列出真实会话', historyRows >= 2, String(historyRows));
  const historyText = await page.locator('[aria-label="历史会话"]').innerText().catch(() => '');
  record(
    '历史会话显示工作区与会话标题',
    historyText.includes('整理历史会话验收记录') && historyText.includes('帮我整理一份会议纪要模板') && historyText.includes('未归属工作区'),
    historyText.slice(0, 140).replace(/\n/g, ' '),
  );
  const restoredText = await page.locator('.cs-message-list').innerText().catch(() => '');
  record('刷新后回到上次会话并保留真实消息', restoredText.includes('整理历史会话验收记录'), restoredText.slice(0, 80).replace(/\n/g, ' '));
  // 7b) 侧栏行级操作：真实重命名 + 悬浮操作区 + 工作区新建入口
  const renamed = await rpc('session.ops.rename', { sessionId, title: '重命名验收会话' });
  record('session.ops.rename 真实改写会话标题', renamed?.ok === true, String(renamed?.error ?? ''));
  const workspaceDir = path.join(root, 'acceptance-workspace');
  mkdirSync(workspaceDir, { recursive: true });
  const addedWorkspace = await rpc('workspace.add', { path: workspaceDir });
  record('workspace.add 注册真实工作区目录', addedWorkspace?.ok === true, String(addedWorkspace?.error ?? ''));
  await page.reload({ waitUntil: 'networkidle' });
  await wait(2000);
  const renamedText = await page.locator('[aria-label="历史会话"]').innerText().catch(() => '');
  record('侧栏出现重命名后的会话标题', renamedText.includes('重命名验收会话'), renamedText.replace(/\n/g, ' ').slice(0, 90));

  const targetRow = page.locator('[aria-label="历史会话"] .cs-session-row').first();
  await targetRow.hover();
  await wait(400);
  const actionCount = await targetRow.locator('.cs-row-actions button').count();
  record('会话行悬浮显示重命名/分叉/归档三枚操作', actionCount === 3, String(actionCount));
  const managedRow = page.locator('[aria-label="历史会话"] .cs-workspace-row', { hasText: 'acceptance-workspace' }).first();
  await managedRow.hover();
  await wait(300);
  const workspaceActions = await managedRow.locator('.cs-row-actions button').count();
  const workspaceAdd = await managedRow.locator('.cs-row-add').count();
  record('工作区行提供重命名/移除与新建会话入口', workspaceActions >= 2 && workspaceAdd === 1, JSON.stringify({ workspaceActions, workspaceAdd }));

  // 还原标题，后续步骤仍按原标题切换会话
  await rpc('session.ops.rename', { sessionId, title: '帮我整理一份会议纪要模板' });
  await page.reload({ waitUntil: 'networkidle' });
  await wait(1500);

  await page.locator('[aria-label="历史会话"] .cs-session-row', { hasText: '帮我整理一份会议纪要模板' }).first().click({ force: true });
  await wait(1800);
  const switchedText = await page.locator('.cs-message-list').innerText().catch(() => '');
  record(
    '点击历史会话载入该会话消息',
    switchedText.includes('长文本验收') && !switchedText.includes('整理历史会话验收记录'),
    switchedText.slice(0, 80).replace(/\n/g, ' '),
  );
  await page.locator('button[aria-label="搜索会话"]').first().click();
  await page.locator('.cs-history-search').fill('整理历史会话验收记录');
  await wait(1200);
  const searchedRows = await page.locator('[aria-label="历史会话"] .cs-session-row').count();
  record('搜索按标题收敛历史会话', searchedRows === 1, String(searchedRows));
  await page.screenshot({ path: path.join(outDir, '07-history.png') });

  // 8) composer 控件：预设切换、访问模式、会话日志、视图选项、附件入口
  await page.locator('button[aria-label="Agent 预设"]').first().click();
  await wait(400);
  const presetMenu = await page.locator('.cs-menu-panel').innerText().catch(() => '');
  record(
    '预设菜单列出真实预设',
    presetMenu.includes('标准') && presetMenu.includes('极简') && presetMenu.includes('运行时改造'),
    presetMenu.slice(0, 90).replace(/\n/g, ' '),
  );
  await page.locator('.cs-menu-panel .cs-menu-item', { hasText: '极简' }).first().click();
  await wait(1500);
  const afterPreset = await page.locator('.cs-conversation-title').innerText().catch(() => '');
  record('切换预设后会话头部显示新预设', afterPreset.includes('极简'), afterPreset.replace(/\n/g, ' '));

  await page.locator('button[aria-label="访问模式"]').first().click();
  await wait(400);
  await page.locator('.cs-menu-panel .cs-menu-item', { hasText: '只读' }).first().click();
  await wait(1500);
  const accessTrigger = await page.locator('button[aria-label="访问模式"]').first().innerText().catch(() => '');
  record('访问模式可切换为只读', accessTrigger.includes('只读'), accessTrigger.replace(/\n/g, ' '));

  await page.locator('button[aria-label="会话日志"]').first().click();
  await wait(1500);
  const logText = await page.locator('.cs-log-body').innerText().catch(() => '');
  record(
    '会话日志展示真实记录',
    logText.includes('"record": "header"') && logText.includes('"record": "message"'),
    logText.slice(0, 90).replace(/\n/g, ' '),
  );
  await page.locator('button[aria-label="关闭会话日志"]').click().catch(() => undefined);
  await wait(400);

  await page.locator('button[aria-label="视图选项"]').first().click();
  await wait(400);
  await page.locator('.cs-menu-panel .cs-menu-item', { hasText: '思考区域' }).first().click();
  await wait(900);
  const reasoningCount = await page.locator('.cs-reasoning').count();
  record('视图选项真实影响渲染（关闭思考区域）', reasoningCount === 0, String(reasoningCount));

  await page.locator('button[aria-label="添加附件"]').first().click();
  await wait(900);
  const pickerText = await page.locator('.wp-panel').innerText().catch(() => '');
  record('添加附件打开工作区文件选择器', pickerText.includes('添加附件'), pickerText.slice(0, 70).replace(/\n/g, ' '));
  await page.locator('.wp-icon').first().click().catch(() => undefined);
  await wait(400);
  await page.screenshot({ path: path.join(outDir, '08-controls.png') });

  // 9) 三栏结构：左侧工作区会话页 / 中间会话页 / 右侧插件侧栏
  const leftOk = await page.evaluate(() => ({
    hasShell: Boolean(document.querySelector('.cs-shell')),
    newSession: Boolean(document.querySelector('.cs-new-session')),
    history: Boolean(document.querySelector('[aria-label="历史会话"]')),
    settings: Boolean(document.querySelector('.cs-settings')),
  }))
  record(
    '左侧栏含新会话、历史会话与设置',
    leftOk.hasShell && leftOk.newSession && leftOk.history && leftOk.settings,
    JSON.stringify(leftOk),
  )

  // 8b) 参考实现对齐度量：三栏宽度、composer 卡片圆角、发送键尺寸、右栏页签
  const layoutMetrics = await page.evaluate(() => {
    const sidebar = document.querySelector('.cs-sidebar')
    const card = document.querySelector('.cs-conversation-composer') ?? document.querySelector('.cs-composer')
    const send = document.querySelector('.cs-conversation-send') ?? document.querySelector('.cs-composer-send')
    const rect = (el) => (el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null)
    return {
      sidebar: rect(sidebar),
      cardRadius: card ? getComputedStyle(card).borderTopLeftRadius : null,
      send: rect(send),
      railTabs: [...document.querySelectorAll('[role="tablist"] [role="tab"]')].map((tab) => tab.getAttribute('aria-label')),
    }
  })
  record(
    '左栏默认宽度 280px 且可折叠',
    layoutMetrics.sidebar !== null && layoutMetrics.sidebar.w === 280,
    JSON.stringify(layoutMetrics.sidebar),
  )
  record(
    'composer 卡片圆角与发送键尺寸对齐参考实现',
    layoutMetrics.cardRadius === '22px' && layoutMetrics.send !== null && layoutMetrics.send.w === 34 && layoutMetrics.send.h === 34,
    JSON.stringify({ cardRadius: layoutMetrics.cardRadius, send: layoutMetrics.send }),
  )
  record(
    '右栏由插件贡献 dock 面板（任务管理 / 上下文）',
    Array.isArray(layoutMetrics.railTabs) &&
      layoutMetrics.railTabs.includes('任务管理') &&
      layoutMetrics.railTabs.includes('上下文'),
    JSON.stringify(layoutMetrics.railTabs),
  )

  const rail = page.locator('[aria-label="插件"]')
  record('右侧插件侧栏存在', (await rail.count()) === 1, String(await rail.count()))
  const dockPanes = await rpc('capability.dock', {})
  const paneTitles = (dockPanes?.result?.panes ?? []).map((pane) => pane.title)
  record(
    'capability.dock 返回插件贡献的面板',
    paneTitles.includes('任务管理') && paneTitles.includes('上下文') && paneTitles.length >= 5,
    JSON.stringify(paneTitles),
  )

  // 9b) 上下文面板：真实预算与分区
  await page.locator('button[aria-label="上下文"]').first().click()
  await wait(1800)
  const contextPanel = await rail.innerText().catch(() => '')
  record(
    '上下文面板展示真实预算与分区',
    contextPanel.includes('tok') || contextPanel.includes('估算') || contextPanel.includes('先选择会话'),
    contextPanel.replace(/\n/g, ' ').slice(0, 110),
  )

  // 9c) 技能能力：真实 create → list 回显（插件清单已移至设置）
  const createdSkill = await rpc('skill.create', {
    name: '验收技能',
    description: '浏览器验收用技能',
    content: '步骤一：读取目标；步骤二：执行实验；步骤三：登记产物。',
    tags: ['验收'],
  })
  record('skill.create 写入真实技能文件', createdSkill?.ok === true, String(createdSkill?.error ?? ''))
  const skills = await rpc('skill.list', {})
  record(
    'skill.list 返回真实技能条目',
    JSON.stringify(skills?.result ?? {}).includes('验收技能'),
    JSON.stringify(skills?.result ?? {}).slice(0, 90),
  )
  await page.screenshot({ path: path.join(outDir, '10-plugin-rail.png') })
  // 回到会话视图，后续窄屏与断连检查针对会话页
  await page.locator('.cs-back-button').first().click().catch(() => undefined)
  await wait(800)

  // 10) 窄屏布局
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(500);
  const narrow = await page.evaluate(() => {
    const composer = document.querySelector('.cs-conversation-composer');
    const textarea = document.querySelector('.cs-conversation-composer textarea');
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      composerVisible: composer ? composer.getBoundingClientRect().bottom <= window.innerHeight + 1 : false,
      textareaVisible: textarea ? textarea.getBoundingClientRect().width > 0 : false,
    };
  });
  record('窄屏 390x844 无横向溢出且控件可见', narrow.overflow <= 1 && narrow.composerVisible && narrow.textareaVisible, JSON.stringify(narrow));
  await page.screenshot({ path: path.join(outDir, '06-narrow.png') });

  // 11) 断连提示与恢复
  await page.setViewportSize({ width: 1440, height: 900 });
  server.kill('SIGKILL');
  await wait(1200);
  await page.locator('textarea:visible').first().fill('断连检查').catch(() => undefined);
  await page.locator('button[aria-label="发送消息"]:visible').first().click().catch(() => undefined);
  await page.waitForFunction(() => document.body.innerText.includes('发送失败') || document.querySelector('.cs-online-dot.offline') !== null, null, { timeout: 30000 })
    .then(() => record('断连时显示真实失败与离线状态', true))
    .catch(() => record('断连时显示真实失败与离线状态', false, '未出现断连提示'));
  await page.screenshot({ path: path.join(outDir, '09-disconnected.png') });

  report.results = results;
  report.passed = results.filter((item) => item.ok).length;
  report.total = results.length;
  writeFileSync(path.join(outDir, 'ui-acceptance.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('RESULT ' + report.passed + '/' + report.total);
  console.log('OUT ' + outDir);
  process.exitCode = report.passed === report.total ? 0 : 1;
} catch (error) {
  report.error = String(error && error.stack ? error.stack : error);
  writeFileSync(path.join(outDir, 'ui-acceptance.json'), JSON.stringify(report, null, 2), 'utf8');
  console.error('ACCEPTANCE-ERROR', error);
  process.exitCode = 2;
} finally {
  await browser.close().catch(() => undefined);
  if (!server.killed) server.kill('SIGKILL');
}