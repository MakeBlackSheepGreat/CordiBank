"use strict";

/**
 * 预加载脚本：在隔离上下文里暴露最小必要的接口。
 *
 * 前端与后端同源，通信直接走 /rpc，无需经由这里。
 */

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("cordibank", {
  /** 打包版本号，便于界面显示。 */
  version: "1.0.0",
  /** 平台信息。 */
  platform: process.platform,
});
