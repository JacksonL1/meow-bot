"use strict";
// ============================================================================
// Tauri 版的 window.clawd / window.bubble / window.dashboard
//
// 为什么不改渲染层：src/renderer.js 里那些 `if (window.clawd)` 的判断是
// 有意的——它让同一份页面跑在三种宿主里（Electron、Tauri、纯浏览器预览）。
// 所以容器换 Rust 这件事，在渲染层看来应该**完全无感**：只要有个形状相同的
// 对象挂在 window 上，1800 行渲染代码一行都不用动。
//
// 这个文件**必须**在 renderer.js / bubble-renderer.js / dashboard-renderer.js
// 之前引入（见三份 HTML 的 <script> 顺序）：那些文件是顶层立刻读 window.clawd
// 的，晚一步就只有"浏览器预览模式"那一支能走，桌宠会一直发呆。
//
// Electron 下这个文件是空转（window.__TAURI_INTERNALS__ 不存在，第 24 行就 return），
// 所以同一份 HTML 两边都能用，不需要维护两套页面。
//
// 2026-11-02（S10-6②）：`withGlobalTauri` 已关掉，`window.__TAURI__` 不再注入。
// 这是**真实的安全性收缩**：那一整套便利 API 里有 `core.invoke`，
// 任何注入到页面里的脚本都能发现它、用它调任意命令。
// 现在页面只剩 `window.__TAURI_INTERNALS__`（Tauri 内部用的那个），
// 它不是文档化的公开入口，名字也不出现在任何示例里——**但摘不掉**：
// 它的属性描述符是 `writable:false, configurable:false`（实测，见 DEVLOG），
// 所以"关掉 withGlobalTauri"缩小的是**可发现面**，不是"渲染层拿不到通用口子"。
// 真正兜底的是 Rust 侧那层每窗口白名单（`only()`），那一条才是硬边界。
// ============================================================================

(function () {
  // 8 行自己拼 invoke / listen。为什么不用 @tauri-apps/api：
  // 那个包最后也是调这两个内部接口，而项目对 Tauri 侧的约定是零 npm 依赖。
  const I = window.__TAURI_INTERNALS__;
  if (!I || typeof I.invoke !== "function") return;

  const invoke = I.invoke.bind(I);
  const transform = I.transformCallback.bind(I);

  // `event.listen` 的等价物。三个参数一个都不能少：
  //   event  —— 事件名
  //   target —— { kind: "Any" }（枚举 EventTarget 是 #[serde(tag = "kind")]）
  //   handler—— transformCallback 发出来的数字 id，不是函数
  // 返回值是 Promise<EventId>，与原来的 listen 同形。
  function listen(name, cb) {
    return invoke("plugin:event|listen", {
      event: name,
      target: { kind: "Any" },
      handler: transform(cb),
    });
  }

  // ------------------------------------------------------------
  // 下行：事件通道
  //
  // Tauri 的 listen 是**异步**的（返回 Promise），而 Electron 的
  // ipcRenderer.on 是同步的。三个渲染层都是"先 on、后 ready"的顺序假设，
  // 最要紧的是气泡：bubble-renderer.js 先 onRequest(render) 再 ready()，
  // 主进程收到 ready 就会把攒着的第一个权限请求吐出来。如果注册是异步的、
  // 而握手是同步的，第一个请求就会在监听器挂上之前被 emit 掉——表现是
  // "第一次弹权限框永远是空的"，而第二次正常，最难查的那类 bug。
  //
  // 挡法：每条通道只 listen 一次，且**在脚本加载时就挂上**，把"注册"
  // 提前到任何调用方之前；ready() 再显式等一次这条 Promise。
  // ------------------------------------------------------------
  const subs = Object.create(null);
  const reading = Object.create(null);

  function channel(name) {
    if (!reading[name]) {
      subs[name] = subs[name] || [];
      reading[name] = listen(name, (e) => {
        // 一个订阅者抛错不能连累其他订阅者（比如 theme 有两个订阅者：
        // adoptTheme 和看板的 onTheme）。否则一次主题应用出错就再也收不到推送。
        for (const cb of subs[name]) {
          try {
            cb(e.payload);
          } catch (err) {
            console.error("[bridge] 订阅者抛错:", name, err);
          }
        }
      }).catch((err) => {
        // 注册失败不吞声：吞了以后表现是"功能静默失效"，比报错难查得多。
        console.error("[bridge] 订阅失败:", name, err);
      });
    }
    return reading[name];
  }

  function on(name, cb) {
    const ready = channel(name);
    if (typeof cb === "function") subs[name].push(cb);
    return ready;
  }

  // ------------------------------------------------------------
  // 上行：命令
  //
  // send  = 发完不管（对应 Electron 的 ipcRenderer.send）
  // call  = 等结果（对应 ipcRenderer.invoke）
  //
  // send 一定要吞掉异常：Electron 的 send 从不 reject，渲染层因此一行
  // catch 都没写。Tauri 的 invoke 会 reject（命令不存在、参数类型不符、
  // 命令里 return Err），不吞的话拖一次窗口就是一条 unhandled rejection，
  // 而且这类报错会一直刷屏，把真正的问题埋掉。
  // ------------------------------------------------------------
  function send(cmd, args) {
    return invoke(cmd, args || {}).catch((err) => {
      console.error("[bridge] 命令失败:", cmd, err);
      return undefined;
    });
  }

  function call(cmd, args) {
    return invoke(cmd, args || {});
  }

  // ------------------------------------------------------------
  // 主窗口
  // 动作清单 13 条（原先与 Electron 的 preload.js 一一对应，容器删掉后这份就是唯一实现），
  // 方便两边 diff 时一眼看出漏了谁。
  // ------------------------------------------------------------
  window.clawd = {
    onState: (cb) => on("state", cb),
    // 和 onState 分开的两条线：state 只在 visual 变化时推，
    // 分身要的是每条会话自己的状态（见 src-tauri/src/main.rs 的 cast 线程）。
    onCast: (cb) => on("cast", cb),
    onGaze: (cb) => on("gaze", cb),
    dragStart: () => send("drag_start"),
    dragEnd: () => send("drag_end"),
    setIgnoreMouse: (ignore) => send("mouse_ignore", { ignore: Boolean(ignore) }),
    // 命中区上报：告诉宿主"猫在哪"（CSS px 矩形列表），由宿主的 60ms 看门狗
    // 决定整窗穿不穿透。**不能靠页面自己收 mousemove 再关穿透**——
    // Windows 上 WS_EX_TRANSPARENT 一旦设上，WebView2 一条 mousemove 都收不到，
    // 等它回话就是死锁（2026-11-04 的手感事故，见 main.rs 的 hit_rects 注释）。
    setHitRects: (rects) => send("hit_rects", { rects: rects || [] }),
    hitState: () => call("hit_state"),
    // 只读诊断：DSH 适配层此刻看到了什么（装没装、读没读到、产出过几条事件）。
    // 与 hitState 同一个用途——用户说"接上了但猫不动"时，一次说清死在哪一步。
    dshState: () => call("dsh_state"),
    // 鼠标停上去只是"请求"醒来，真正改状态的是主进程的状态机。
    wake: () => send("pet_hover"),
    quit: () => send("app_quit"),
    petMenu: () => send("pet_menu"),
    toggleDashboard: () => send("dashboard_toggle"),
    // 拉（启动时一次）+ 推（看板里切主题）两条，与 Electron 版同构。
    getTheme: () => call("theme_get"),
    onTheme: (cb) => on("theme", cb),
    // ---- 「说一句话」（2026-11-05）----
    // 打开输入窗。id 为空 = 新起一条；给了 id = 接着它说（宿主会先判能不能续）。
    openCompose: (id) => call("compose_open", { id: id || null }),
    // 真正发出去。**参数只有 id 和文字**：目录由宿主从状态机里查，
    // 前端传不进来一个路径——这条边界是有意的（见 main.rs 的 say_send）。
    saySend: (id, text) => call("say_send", { id: id || null, text: String(text) }),
    // 结局（成功 / 失败原因）从这条回来。不看返回值，是因为它可能在
    // 几分钟后才到——那时调用它的那行代码早就跑完了。
    onSayDone: (cb) => on("say:done", cb),
    // 输入窗自己用：加载完来要一次目标（第一次打开时 compose:open 会赶在
    // 页面就绪之前发出，收不到），以及关掉自己。
    composeContext: () => call("compose_context"),
    composeClose: () => send("compose_close"),
    // 答案落地后把窗口长到刚好放得下（h=0 恢复基准高度）。
    composeHeight: (h) => send("compose_height", { h: Number(h) || 0 }),
    onComposeOpen: (cb) => on("compose:open", cb),
  };

  // ------------------------------------------------------------
  // 权限气泡
  // ------------------------------------------------------------
  window.bubble = {
    onRequest: (cb) => on("permission:request", cb),
    // 用 call 而不是 send：渲染层必须知道"这条请求还在不在账上"。
    // 用 send 的话失败会被吞掉，气泡就会停在一张点不动的卡片上。
    decide: (id, decision) => call("permission_decide", { id, decision }),
    // 卡片对应的请求已经结束（超时 / 已被结掉）时收窗，不产生任何裁决。
    close: (id) => send("bubble_close", { id: id === null ? null : id }),
    setHeight: (h) => send("bubble_height", { h }),
    // 握手：只有监听器真的挂上了才通知主进程放行。
    // 这里调 channel() 而不是依赖调用方先调过 onRequest——少一个隐含顺序。
    ready: () => {
      channel("permission:request").then(() => send("bubble_ready"));
    },
  };

  // ------------------------------------------------------------
  // 会话看板
  //
  // 同样没有"取完整 cwd"的接口：完整路径留在 Rust 侧，
  // 只有用户点了"复制路径"才由主进程塞进剪贴板（SEC-09 的分层）。
  // ------------------------------------------------------------
  window.dashboard = {
    getSnapshot: () => call("dashboard_snapshot"),
    copyPath: (id) => call("dashboard_copy_path", { id }),
    listThemes: () => call("theme_list"),
    setTheme: (id) => call("theme_set", { id }),
    onTheme: (cb) => on("theme", cb),
    // 看板的**内容**：每条会话在干什么（最后一轮对话、模型、token、上下文）。
    // 和 getSnapshot 分两条：那是"猫在演什么"，这是"会话里发生了什么"。
    // 看板的内容来源。2026-11-10 起它不只服务 DSH：WorkBuddy / Claude Code 的
    // 会话也在里面（磁盘扫描），靠每行的 `agent` 字段区分平台。
    agentSessions: () => call("agent_sessions"),
    // 对着某条会话说一句（和桌宠走同一个 say_send）
    saySend: (id, text) => call("say_send", { id: id || null, text: String(text) }),
    onSayDone: (cb) => on("say:done", cb),
  };

  // 诊断用：回归脚本要靠它判断"现在到底是哪个宿主在跑"。
  // Electron 下 window.__TAURI__ 不存在，这个键也就不会出现，
  // 所以回归脚本的老断言不会被它影响。
  window.__CLAWD_HOST__ = "tauri";
})();
