"use strict";

/**
 * CordiBank 桌面应用主进程。
 *
 * 职责有三件：把 runtime 后端跑起来并托管前端、准备 MCP 服务清单、窗口生命周期管理。
 * 后端与前端同源，界面直接访问 http://127.0.0.1:<port>，省掉跨域与代理配置。
 */

/**
 * 清理宿主环境注入的 Node 变量。
 *
 * 打包版 Electron 不支持 NODE_OPTIONS，遇到时会直接报错退出；
 * ELECTRON_RUN_AS_NODE 会让可执行文件退化成纯 Node，界面起不来。
 * 主进程清掉这两个变量后重启自己，恢复成正常的桌面应用模式。
 */
const hostileEnv = ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"];
const polluted = hostileEnv.some((key) => process.env[key] !== undefined);
if (polluted) {
  for (const key of hostileEnv) delete process.env[key];
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env },
  });
  process.exit(result.status ?? 0);
}

const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { pathToFileURL } = require("node:url");
const os = require("node:os");

/**
 * 启动诊断日志。
 *
 * 先写到系统临时目录，这个路径不依赖 app 是否 ready，模块加载期出错也能留痕。
 * app ready 后再切换到用户数据目录。
 */
// 日志写多个候选位置，总有一个能落盘，便于排查打包版的启动问题。
const logTargets = [
  path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "cordibank-desktop.log"),
  path.join(process.env.TEMP ?? os.tmpdir(), "cordibank-desktop.log"),
  path.join(os.tmpdir(), "cordibank-desktop.log"),
];
let userLogFile = "";
function log(message) {
  // stdout 不受宿主环境的文件写入拦截影响，打包版排障靠它。
  try {
    process.stdout.write(`[cordibank] ${message}\n`);
  } catch {
    /* stdout 不可用时忽略 */
  }
  const line = `[${new Date().toISOString()}] ${message}\n`;
  for (const target of [...logTargets, userLogFile]) {
    if (target === "") continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, line, "utf8");
    } catch {
      /* 日志失败不阻断启动 */
    }
  }
}

/**
 * 应用名与用户数据目录。
 *
 * Electron 默认用 package.json 的 name 作为应用名，userData 目录随之命名。
 * 打包后展示名是 productName，这里统一成同一个，避免数据目录名与应用名对不上。
 * setName 必须在 ready 之前调用才会影响 userData 路径，getPath 则要等 ready 之后。
 */
let storeDir = "";
function initAppPaths() {
  // 应用名决定 userData 目录名。放在 ready 之后调用，避免过早触碰 app 状态。
  app.setName("CordiBank 蜂群银行助手");
  const userData = app.getPath("userData");
  storeDir = path.join(userData, "store");
  userLogFile = path.join(userData, "desktop.log");
  log(`paths ready: userData=${userData}`);
}

/** 开发模式下直连仓库内的 runtime 源码，打包后指向随包资源。 */
const isPackaged = app.isPackaged;
const resourcesRoot = isPackaged
  ? path.join(process.resourcesPath)
  : path.join(__dirname, "..");

/**
 * 运行时目录。
 *
 * 开发模式下 runtime 未编译，入口在源码里；打包后编译产物落在 runtime/dist。
 */
const runtimeSourceDir = path.join(resourcesRoot, "..", "runtime");
const runtimeDistDir = path.join(runtimeSourceDir, "dist");
const runtimeDir = isPackaged
  ? path.join(resourcesRoot, "runtime")
  : fs.existsSync(path.join(runtimeDistDir, "server.js"))
    ? runtimeDistDir
    : runtimeSourceDir;

/** 前端构建产物目录。 */
const webDistDir = isPackaged
  ? path.join(resourcesRoot, "web")
  : path.join(resourcesRoot, "..", "web", "dist");

/** MCP 服务目录与预置清单。 */
const mcpDir = isPackaged
  ? path.join(resourcesRoot, "mcp")
  : path.join(resourcesRoot, "..", "mcp");

/** 技能目录。 */
const skillsDir = isPackaged
  ? path.join(resourcesRoot, "skills")
  : path.join(resourcesRoot, "..", "skills");

log("main.cjs loaded");

/** 窗口与后端句柄。 */
let mainWindow = null;
let serverHandle = null;

/**
 * 把预置 MCP 清单写进运行时 store。
 *
 * 打包后不能直接用仓库里的 servers.json：它假设系统装有 node 命令，
 * 而评委机器上未必装了 Node。桌面应用改用 Electron 自带的 Node 运行时，
 * 靠 ELECTRON_RUN_AS_NODE 让可执行文件以纯 Node 模式启动。
 *
 * 开发模式下沿用系统 node 命令，此时本机必有 Node。
 * 两种模式的可执行文件路径不同，manifest 每次启动都重写，避免指向失效路径。
 */
async function seedMcpServers() {
  const target = path.join(storeDir, "mcp.json");
  const presetFile = path.join(mcpDir, "servers.json");
  if (!fs.existsSync(presetFile)) return;

  const normalizedMcpDir = path.resolve(mcpDir).split(path.sep).join("/");
  const raw = fs.readFileSync(presetFile, "utf8").split("__MCP_DIR__").join(normalizedMcpDir);
  const parsed = JSON.parse(raw);

  for (const server of parsed.servers ?? []) {
    if (server.transport !== "stdio") continue;
    if (isPackaged) {
      // Electron 可执行文件加 ELECTRON_RUN_AS_NODE 等价于 node 命令。
      // 走引导脚本，让子进程先清掉宿主注入的环境变量，再加载真正的 MCP 服务。
      server.command = process.execPath;
      server.args = [path.join(__dirname, "mcp-bootstrap.cjs"), ...(server.args ?? [])];
      server.env = { ...(server.env ?? {}), ELECTRON_RUN_AS_NODE: "1" };
    } else {
      server.command = "node";
      server.env = { ...(server.env ?? {}) };
    }
  }

  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(parsed, null, 2), "utf8");
  log(`mcp manifest written: ${target}`);
}

/** 轮询后端健康检查，直到服务就绪或超时。 */
async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await new Promise((resolve) => {
      const request = http.get(`http://127.0.0.1:${port}/health`, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.on("error", () => resolve(false));
      request.setTimeout(2000, () => {
        request.destroy();
        resolve(false);
      });
    });
    if (alive) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

/**
 * 后端入口文件。
 *
 * 打包后编译产物落在 resources/runtime 下，入口是 server.js。
 * 开发模式下 runtime 未编译，入口在源码 src/server.ts，
 * Electron 内置的 Node 24 支持直接加载 TypeScript。
 */
function resolveRuntimeEntry() {
  const candidates = isPackaged
    ? [path.join(runtimeDir, "server.js"), path.join(runtimeDir, "dist", "server.js")]
    : [
        path.join(runtimeDistDir, "server.js"),
        path.join(runtimeSourceDir, "src", "server.ts"),
      ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

/** 启动后端服务。 */
async function startBackend() {
  await seedMcpServers();

  const entry = resolveRuntimeEntry();
  if (!fs.existsSync(entry)) {
    throw new Error(`找不到后端入口：${entry}`);
  }
  log(`runtime entry: ${entry}`);

  const module = await import(pathToFileURL(entry).href);
  const startServer = module.default ?? module.startServer;

  // loadConfig 定义在 config.js，与入口文件同级。
  const configEntry = path.join(path.dirname(entry), "config.js");
  const configModule = await import(pathToFileURL(configEntry).href);
  const loadConfig = configModule.loadConfig;

  // 路径全部走 loadConfig 覆盖，端口传 0 由系统分配，避免与本机已有服务冲突。
  const cfg = loadConfig({
    repoRoot: resourcesRoot,
    storeDir,
    skillsDir,
    webDistDir,
    mcpPresetFile: path.join(mcpDir, "servers.json"),
    rpcPort: 0,
  });

  const handle = await startServer({ port: 0, cfg });
  serverHandle = handle;
  log(`backend started on ${handle.port}`);
  return handle.port;
}

/** 主进程自检：请求后端接口与前端首页，把结果写进日志。 */
async function selfCheck(port) {
  const rpc = await new Promise((resolve) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/rpc",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    request.on("error", (error) => resolve(`rpc error: ${error.message}`));
    request.setTimeout(8000, () => {
      request.destroy();
      resolve("rpc timeout");
    });
    request.end(JSON.stringify({ method: "bank.agent.tools", params: [] }));
  });
  log(`self check tools: ${rpc.slice(0, 160)}`);

  // 再验一条真实业务链路：走 MCP 换汇，外部服务与内置判定都要通。
  const mcp = await new Promise((resolve) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/rpc",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    request.on("error", (error) => resolve(`mcp error: ${error.message}`));
    request.setTimeout(15000, () => {
      request.destroy();
      resolve("mcp timeout");
    });
    request.end(
      JSON.stringify({
        method: "bank.agent.swarm",
        params: ["selfcheck", "100 美元换多少人民币"],
      }),
    );
  });
  log(`self check mcp: ${mcp.slice(0, 200)}`);

  const page = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/`, (response) => {
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
      });
      response.on("end", () => resolve(`HTTP ${response.statusCode} ${size} bytes`));
    }).on("error", (error) => resolve(`page error: ${error.message}`));
  });
  log(`self check page: ${page}`);
}

/** 创建主窗口。 */
function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: "#0B1220",
    title: "CordiBank 蜂群银行助手",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    log("window shown");
    // 自检：主进程直接请求自己的接口，确认后端与前端托管都可用。
    void selfCheck(port);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    log("page loaded");
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    log(`page failed to load: ${code} ${description} ${url}`);
  });

  app.on("render-process-gone", (_event, _contents, details) => {
    log(`render process gone: ${details.reason}`);
  });

  // 外部链接走系统浏览器，不在应用内开新窗口。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** 应用菜单：保留复制粘贴等编辑快捷键，去掉默认项。 */
function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        {
          label: "重置演示数据",
          click: async () => {
            if (!serverHandle) return;
            await new Promise((resolve) => {
              const request = http.request(
                {
                  host: "127.0.0.1",
                  port: serverHandle.port,
                  path: "/rpc",
                  method: "POST",
                  headers: { "content-type": "application/json" },
                },
                (response) => {
                  response.resume();
                  resolve(undefined);
                },
              );
              request.on("error", () => resolve(undefined));
              request.end(
                JSON.stringify({ method: "bank.agent.reset", params: [] }),
              );
            });
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "已重置",
              message: "演示数据已恢复到初始状态。",
              buttons: ["好"],
            });
          },
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  log("app ready");
  try {
    initAppPaths();
  } catch (error) {
    log(`initAppPaths failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    throw error;
  }
  buildMenu();
  try {
    const port = await startBackend();
    if (!(await waitForHealth(port, 15000))) {
      throw new Error("后端健康检查超时");
    }
    log("health ok");
    createWindow(port);
    log("window created");
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    log(`startup failed: ${detail}`);
    // 打包版没有控制台，用对话框把原因呈现给用户。
    dialog.showErrorBox("启动失败", detail);
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverHandle) {
      createWindow(serverHandle.port);
    }
  });
});

app.on("window-all-closed", () => {
  log("all windows closed");
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async (event) => {
  log("before-quit");
  if (serverHandle) {
    await serverHandle.close();
    serverHandle = null;
  }
});

process.on("exit", (code) => {
  log(`process exit code=${code}`);
});

// 主进程崩溃时留下痕迹，否则打包版启动失败会毫无线索。
process.on("uncaughtException", (error) => {
  log(`uncaughtException: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
});
process.on("unhandledRejection", (reason) => {
  log(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});
