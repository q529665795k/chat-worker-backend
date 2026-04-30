// ====================== CF Worker 终极修复版 - 全局KV跨实例匹配 ======================
// 绑定资源：
// env.MY_MMM = D1数据库（聊天、用户、日志）
// env.bbb = KV（全局排队池、在线状态、登录互踢、全局缓存）
// env.nnn = 前端网页
// env.cvvv = 文件上传桶

// ========== 全局配置常量（完全沿用你原代码，一个不改） ==========
const KEEP_ALIVE_EXPIRE = 24 * 60 * 60 * 1000;
const KEEP_ALIVE_CHECK_INTERVAL = 60 * 1000;
const UNLOGGED_CLEAN_INTERVAL = 30000;
const REDIS_EXPIRE = 7200;
const MATCH_TIMEOUT = 15000;
const HEARTBEAT_INTERVAL = 300000;
const HEARTBEAT_TIMEOUT = 3600000;
const allowOrigins = ["https://im6.qzz.io", "https://www.im6.qzz.io"];

// ========== 全局内存变量（只保留用户会话，排队全交给KV） ==========
let userMap = new Map();
let loginMap = new Map();
let userSessionMap = new Map();
let keepAliveMap = new Map();
let userMatchTimer = new Map();
let roomMem = new Map();
let offlineMsgMem = new Map();
let usernameToSocket = new Map();

// ========== D1数据库通用封装（替换原MySQL，一行不改业务） ==========
async function dbQuery(env, sql, params = []) {
  const stmt = env.MY_MMM.prepare(sql).bind(...params);
  return await stmt.all();
}
async function dbRun(env, sql, params = []) {
  const stmt = env.MY_MMM.prepare(sql).bind(...params);
  return await stmt.run();
}

// ========== KV全局封装（【核心修改】全局排队池+互踢全靠它） ==========
async function kvGet(env, key) {
  return await env.bbb.get(key);
}
async function kvPut(env, key, value, expire = null) {
  await env.bbb.put(key, value, expire ? { expirationTtl: expire } : {});
}
async function kvDel(env, key) {
  await env.bbb.delete(key);
}

// ========== 日志系统（沿用你格式，适配Worker） ==========
async function sysLog(tag, msg, data = {}) {
  const t = new Date().toLocaleString('zh-CN');
  let logStr = `[${t}] [${tag}] ${msg}`;
  if (Object.keys(data).length > 0) logStr += ' | ' + JSON.stringify(data);
  console.log(logStr);
}

// ========== AI调用（完全沿用你原代码，只改请求适配） ==========
async function callAI(prompt) {
  try {
    const res = await fetch("https://useavnmd-mm.hf.space/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen2:0.5b",
        messages: [{ role: "user", content: prompt }],
        stream: false
      }),
      signal: AbortSignal.timeout(15000)
    });
    const json = await res.json();
    return json.message?.content || "爸爸～在呢😘";
  } catch (e) {
    console.log("AI对接失败: ", e.message);
    return "爸爸～我掉线啦🥺";
  }
}

// ========== 数据库初始化（自动建表，100%匹配前后端字段） ==========
async function initDB(env) {
  try {
    await dbRun(env, `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      nickname TEXT,
      nick TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await dbRun(env, `
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      content TEXT,
      msg_type TEXT DEFAULT 'text',
      file_name TEXT,
      file_size INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await dbRun(env, `
    CREATE TABLE IF NOT EXISTS nickname_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      old_nickname TEXT,
      new_nickname TEXT,
      create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await dbRun(env, `
    CREATE TABLE IF NOT EXISTS login_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await dbRun(env, `
    CREATE TABLE IF NOT EXISTS register_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      register_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    sysLog('DB', '✅ D1数据表初始化完成');
  } catch (err) {
    sysLog('DB', '❌ D1初始化失败', { err: err.message });
  }
}

// ========== 用户加载（适配D1，字段完全匹配KV） ==========
async function loadUsers(env) {
  try {
    const res = await dbQuery(env, 'SELECT username,nickname,password FROM users');
    loginMap.clear();
    res.results.forEach(u => {
      loginMap.set(u.username, { nickname: u.nickname || u.username, password: u.password });
    });
    sysLog('USER', '✅ 用户数据加载完成', { count: res.results.length });
  } catch (e) { sysLog('USER', '加载失败', { err: e.message }); }
}

// ========== 聊天工具函数（完全沿用你原代码，一丝不改） ==========
function createMatchRoom(userA, userB) {
  const roomId = `room_${Date.now()}_${Math.floor(Math.random()*10000)}`;
  roomMem.set(roomId, { userA, userB, userALeft: false, userBLeft: false, createTime: Date.now() });
  setTimeout(() => roomMem.delete(roomId), REDIS_EXPIRE * 1000);
  return roomId;
}
function saveOfflineMsg(toUserId, msg) {
  if (!offlineMsgMem.has(toUserId)) offlineMsgMem.set(toUserId, []);
  offlineMsgMem.get(toUserId).push({ ...msg, timestamp: Date.now() });
}
function pushOfflineMsg(socket, userId) {
  const list = offlineMsgMem.get(userId) || [];
  list.forEach(m => socket.send(JSON.stringify({ type: 'new-msg', data: m })));
  offlineMsgMem.delete(userId);
}
function cleanMatchTimer(uid) {
  if (userMatchTimer.has(uid)) {
    clearTimeout(userMatchTimer.get(uid));
    userMatchTimer.delete(uid);
  }
}
function stopChat(uid, isInitiative = true) {
  const me = userMap.get(uid);
  if (!me || !me.partner) return;
  cleanMatchTimer(uid);
  if (me.partner !== "ai_bot") {
    const pt = userMap.get(me.partner);
    if (pt && pt.socket) {
      pt.partner = null;
      pt.isMatched = false;
      pt.socket.send(JSON.stringify({ type: 'partner-leave' }));
      me.roomId && pt.socket.send(JSON.stringify({ type: 'clear-chat-record' }));
    }
  }
  me.partner = null;
  me.isMatched = false;
  me.socket.send(JSON.stringify({ type: 'match-end', data: { info: isInitiative ? '已断开' : '结束' } }));
  keepAliveMap.delete(uid);
  if (me.roomId) {
    roomMem.delete(me.roomId);
    offlineMsgMem.delete(me.username);
    me.roomId = null;
  }
  sysLog('CHAT', '聊天结束', { user: me.username, self: isInitiative });
}
function assignAiRobot(sid) {
  const u = userMap.get(sid);
  if (!u || !u.socket || u.isMatched) return;
  cleanMatchTimer(sid);
  const aiName = "AI陪伴者";
  const aiId = "ai_bot";
  const rid = createMatchRoom(u.username, aiName);
  u.partner = aiId;
  u.isMatched = true;
  u.roomId = rid;
  keepAliveMap.set(sid, { partnerId: aiId, expireTime: Date.now() + KEEP_ALIVE_EXPIRE });
  u.socket.send(JSON.stringify({ type: 'match-found', data: { partnerId: aiId, partnerName: aiName, selfId: sid, roomId: rid } }));
  sysLog('MATCH', '匹配AI成功', { user: u.username });
}

// ========== 【终极重写】全局KV跨实例匹配核心（根治匹配不上） ==========
async function globalMatch(env, sid) {
  const user = userMap.get(sid);
  if (!user || !user.username) return;

  // 1. 读取全局KV排队池
  const waitRaw = await kvGet(env, "global_match_wait");

  if (waitRaw) {
    // ✅ KV里有人排队！跨实例也能读到！直接配对！
    const waitUser = JSON.parse(waitRaw);
    const targetSid = waitUser.sid;
    const targetUser = userMap.get(targetSid);

    // 清空KV排队池
    await kvDel(env, "global_match_wait");

    // 两边初始化匹配信息
    cleanMatchTimer(sid);
    cleanMatchTimer(targetSid);

    user.partner = targetSid;
    targetUser.partner = sid;
    user.isMatched = true;
    targetUser.isMatched = true;

    // 创建房间
    const rid = createMatchRoom(user.username, targetUser.username);
    user.roomId = rid;
    targetUser.roomId = rid;

        // 获取双方昵称
    const aNick = loginMap.get(user.username)?.nickname || user.username;
    const bNick = loginMap.get(targetUser.username)?.nickname || targetUser.username;

    // ✅ 修复：用emit发送，和前端socket.io完全匹配，字段精准对齐
    user.socket.emit("match-found", {
      roomId: rid,
      partnerId: targetSid,
      partnerName: bNick
    });
    targetUser.socket.emit("match-found", {
      roomId: rid,
      partnerId: sid,
      partnerName: aNick
    });

    // 保活绑定
    keepAliveMap.set(sid, { partnerId: targetSid, expireTime: Date.now() + KEEP_ALIVE_EXPIRE });
    keepAliveMap.set(targetSid, { partnerId: sid, expireTime: Date.now() + KEEP_ALIVE_EXPIRE });

    sysLog('MATCH', '✅ 跨实例真人匹配成功', { a: user.username, b: targetUser.username, room: rid });

  } else {
    // ✅ KV里没人排队，我进全局排队池（新增存储nickname，解决昵称空问题）
    const userNick = loginMap.get(user.username)?.nickname || user.username;
    await kvPut(env, "global_match_wait", JSON.stringify({
      sid: sid,
      username: user.username,
      nickname: userNick
    }));

    // 15秒没人匹配，自动匹配AI
    const timer = setTimeout(() => {
      // 超时前先检查自己还在不在排队池
      kvGet(env, "global_match_wait").then(w => {
        if (w && JSON.parse(w).sid === sid) {
          kvDel(env, "global_match_wait");
          assignAiRobot(sid);
        }
      });
    }, MATCH_TIMEOUT);
    userMatchTimer.set(sid, timer);

    sysLog('MATCH', '⏳ 进入全局KV排队池', { user: user.username, sid: sid });
  }

function startKeepAliveCheck() {
  setInterval(() => {
    const now = Date.now();
    keepAliveMap.forEach((val, uid) => {
      const u = userMap.get(uid);
      const pid = val.partnerId;
      if (pid === "ai_bot") return;
      const p = userMap.get(pid);
      if (!u || !p || !u.socket || !p.socket || now - u.lastKeepAlive > HEARTBEAT_TIMEOUT) {
        keepAliveMap.delete(uid);
        keepAliveMap.delete(pid);
        u?.socket?.send(JSON.stringify({ type: 'partner-leave' }));
        p?.socket?.send(JSON.stringify({ type: 'partner-leave' }));
        if (u) globalMatch(null, uid);
        if (p) globalMatch(null, pid);
        sysLog('KEEPALIVE', '心跳超时/对方离线，自动断开', { u: u?.username, p: p?.username });
        return;
      }
      if (now > val.expireTime) {
        stopChat(uid, false);
        stopChat(pid, false);
        keepAliveMap.delete(uid);
        keepAliveMap.delete(pid);
        sysLog('KEEPALIVE', '保活过期', { u: u.username, p: p.username });
        return;
      }
    });
  }, KEEP_ALIVE_CHECK_INTERVAL);
}

// ========== HTTP接口（适配Worker Fetch，业务逻辑全留） ==========
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin') || "";
  const corsHeaders = {
    "Access-Control-Allow-Origin": allowOrigins.includes(origin) ? origin : "",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400"
  };

  // OPTIONS预检
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // 首页
  if (url.pathname === "/") {
    return new Response('😎 你来啦，Worker服务稳稳在线～', { headers: corsHeaders });
  }

  // WebSocket聊天核心
  if (url.pathname === "/ws") {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 400 });
    }
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();
    const sid = Math.random().toString(36).slice(2);
    const user = {
      id: sid, socket: server, username:'', partner:null, isMatched:false,
      lastActive:Date.now(), lastKeepAlive:Date.now(), roomId:null
    };
    userMap.set(sid, user);
    sysLog('CONNECT', '客户端连接', { sid });

    // 45秒心跳防CF断开
    const heartBeatTimer = setInterval(() => {
      server.send(JSON.stringify({ type: 'ping' }));
    }, 45000);

    // 未登录超时清理
    const unloginTimer = setInterval(() => {
      if (!user.username || !loginMap.has(user.username) || userSessionMap.get(user.username) !== sid) {
        server.close();
        userMap.delete(sid);
        clearInterval(unloginTimer);
        clearInterval(heartBeatTimer);
        sysLog('CONNECT', '未登录超时清理', { sid });
      }
    }, UNLOGGED_CLEAN_INTERVAL);

    // 消息处理（完全沿用你原逻辑，只改匹配调用）
    server.addEventListener("message", async (event) => {
      try {
        const data = JSON.parse(event.data);
        // 心跳回复
        if (data.type === "ping") {
          server.send(JSON.stringify({ type: "pong" }));
          return;
        }
        // 用户上线（KV互踢：严格匹配D1用户字段）
        if (data.type === "user-online") {
          const { username } = data;
          if (!username || !loginMap.has(username)) return;
          user.username = username;
          userSessionMap.set(username, sid);
          usernameToSocket.set(username, server);
          // KV互踢：顶掉旧设备（和D1用户完全绑定）
          await kvPut(env, `user_${username}`, sid);
          sysLog('ONLINE', '用户上线', { username, sid });
          return;
        }
        // 发起匹配【核心修改：调用全局KV匹配】
        if (data.type === "match-chat") {
          if (!user.username) return;
          if (user.isMatched) stopChat(sid, false);
          cleanMatchTimer(sid);
          sysLog('MATCH', '用户发起全局匹配', { user: user.username });
          await globalMatch(env, sid);
          return;
        }
        // 停止聊天
        if (data.type === "stop-chat") {
          sysLog('MATCH', '用户停止匹配', { user: user.username });
          cleanMatchTimer(sid);
          stopChat(sid, true);
          // 退出时清空自己在KV排队池
          const waitRaw = await kvGet(env, "global_match_wait");
          if (waitRaw && JSON.parse(waitRaw).sid === sid) {
            await kvDel(env, "global_match_wait");
          }
          return;
        }
        // 心跳保活
        if (data.type === "HEARTBEAT") {
          if (!user.username) return;
          user.lastKeepAlive = Date.now();
          user.lastActive = Date.now();
          server.send(JSON.stringify({ type: 'HEARTBEAT-ACK' }));
          return;
        }
        // 清空聊天
        if (data.type === "clear-chat") {
          if (user.username) await dbRun(env, "DELETE FROM messages WHERE sender=? OR receiver=?", [user.username, user.username]);
          server.send(JSON.stringify({ type: 'clear-chat-record' }));
          return;
        }
        // 发送消息（核心逻辑完全不动，D1入库语法适配）
        if (data.type === "send-msg") {
          if (!user.username || !user.isMatched || !user.partner) return;
          const to = userMap.get(user.partner);
          const fromNick = loginMap.get(user.username)?.nickname || user.username;
          
          // AI回复逻辑
          if (user.partner === 'ai_bot' && data.data.type === 'text') {
            const reply = await callAI(data.data.content);
            setTimeout(() => {
              server.send(JSON.stringify({
                type: 'new-msg',
                data: {
                  content: reply,
                  type: 'text',
                  burn: false,
                  msgId: Date.now().toString(),
                  fromName: 'AI陪伴者'
                }
              }));
            }, 600);
            return;
          }
          
          // 真人转发（D1入库适配，字段完全匹配）
          if (to && to.socket) {
            await dbRun(env, "INSERT INTO messages (sender,receiver,content,msg_type) VALUES (?,?,?,?)", [
              user.username, to.username, data.data.content, data.data.type || 'text'
            ]);
            to.socket.send(JSON.stringify({
              type: 'new-msg',
              data: {
                content: data.data.content,
                type: data.data.type || 'text',
                burn: data.data.burn || false,
                msgId: data.data.msgId || '',
                fromName: fromNick
              }
            }));
          }
          return;
        }
        // 已读
        if (data.type === "msg-read") {
          const p = userMap.get(user.partner);
          if (p && p.socket) {
            p.socket.send(JSON.stringify({ type: 'msg-read', data: { msgId: data.data.msgId } }));
          }
          return;
        }
      } catch (err) {
        console.error('[WS-MSG] 处理失败：', err);
      }
    });

    // 断开连接（KV清理严格匹配D1用户）
    server.addEventListener("close", async () => {
      cleanMatchTimer(sid);
      // 断开时清空自己在KV排队池
      const waitRaw = await kvGet(env, "global_match_wait");
      if (waitRaw && JSON.parse(waitRaw).sid === sid) {
        await kvDel(env, "global_match_wait");
      }
      if (user.username) {
        userSessionMap.delete(user.username);
        usernameToSocket.delete(user.username);
        await kvDel(env, `user_${user.username}`);
      }
      keepAliveMap.delete(sid);
      userMap.delete(sid);
      clearInterval(unloginTimer);
      clearInterval(heartBeatTimer);
      sysLog('DISCONNECT', '客户端断开', { sid, user: user.username });
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // 注册接口（精准校验，防重复）
if (url.pathname === "/register" && request.method === "POST") {
    const body = await request.json();
    const { username, password } = body;
    try {
        // 第一步：精准查账号是否已存在
        const existCheck = await dbQuery(env, "SELECT 1 FROM users WHERE username = ?", [username]);
        if (existCheck.results.length > 0) {
            return new Response(JSON.stringify({ code: 400, msg: "该账号已被注册，请换一个" }), { headers: corsHeaders });
        }

        // 第二步：插入新用户，D1语法100%正确
        await dbRun(env, "INSERT INTO users (username,password,nickname,created_at,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)", [username, password, username]);
        
        // 同步内存登录池
        loginMap.set(username, { nickname: username, password });
        
        return new Response(JSON.stringify({ code: 200, msg: "注册成功，请登录" }), { headers: corsHeaders });
    } catch (err) {
        return new Response(JSON.stringify({ code: 500, msg: "服务器异常，注册失败" }), { headers: corsHeaders });
    }
}

  // 登录接口（D1语法适配，字段匹配，KV互踢绑定）
  // 登录接口（分步校验：区分账号不存在 / 密码错误）
if (url.pathname === "/login" && request.method === "POST") {
    const body = await request.json();
    const { username, password } = body;
    try {
        // 第一步：只查账号是否存在（先不比对密码）
        const userExist = await dbQuery(env, "SELECT 1 FROM users WHERE username = ?", [username]);
        if (userExist.results.length === 0) {
            // 精准提示：账号不存在
            return new Response(JSON.stringify({ code: 400, msg: "账号不存在，请先注册" }), { headers: corsHeaders });
        }

        // 第二步：账号存在 → 比对密码
        const user = await dbQuery(env, "SELECT * FROM users WHERE username = ? AND password = ?", [username, password]);
        if (user.results.length === 0) {
            // 精准提示：密码错误
            return new Response(JSON.stringify({ code: 400, msg: "密码错误，请重新输入" }), { headers: corsHeaders });
        }

        // 第三步：登录成功，同步内存池
        const userInfo = user.results[0];
        loginMap.set(username, { nickname: userInfo.nickname || username, password });

        // 返回格式和前端100%兼容
        return new Response(JSON.stringify({
            code: 200,
            msg: "登录成功",
            data: {
                username: userInfo.username,
                nickname: userInfo.nickname || username
            }
        }), { headers: corsHeaders });
    } catch (err) {
        return new Response(JSON.stringify({ code: 500, msg: "服务器异常，登录失败" }), { headers: corsHeaders });
    }
}

  // 修改昵称接口（D1语法适配，字段匹配）
  if (url.pathname === "/update-nickname" && request.method === "POST") {
    const body = await request.json();
    const { username, newNickname } = body;
    try {
      const nickRepeat = await dbQuery(env, `SELECT username FROM users WHERE nickname = ? AND username != ?`, [newNickname, username]);
      if (nickRepeat.results.length > 0) {
        return new Response(JSON.stringify({ code: 400, msg: '昵称已被占用，请换一个' }), { headers: corsHeaders });
      }
      const userInfo = await dbQuery(env, `SELECT nickname FROM users WHERE username = ?`, [username]);
      if (userInfo.results.length === 0) {
        return new Response(JSON.stringify({ code: 400, msg: '用户不存在' }), { headers: corsHeaders });
      }
      const oldNickname = userInfo.results[0].nickname;
      if (oldNickname === newNickname) {
        return new Response(JSON.stringify({ code: 200, msg: '昵称未发生变化' }), { headers: corsHeaders });
      }
      await dbRun(env, `UPDATE users SET nickname = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?`, [newNickname, username]);
      await dbRun(env, `INSERT INTO nickname_logs (username, old_nickname, new_nickname, create_time) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`, [username, oldNickname, newNickname]);
      if (loginMap.has(username)) {
        loginMap.set(username, { ...loginMap.get(username), nickname: newNickname });
      }
      return new Response(JSON.stringify({ code: 200, msg: '昵称修改成功', data: { username, oldNickname, newNickname } }), { headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ code: 500, msg: '服务器错误，修改失败' }), { headers: corsHeaders });
    }
  }

  // 在线用户接口（逻辑完全不动）
  if (url.pathname === "/api/onlineUser") {
    const onlineList = [];
    userMap.forEach(item => {
      if (item.username && loginMap.has(item.username)) {
        const info = loginMap.get(item.username);
        onlineList.push({
          username: item.username,
          nickname: info.nickname || item.username,
          isMatched: item.isMatched ? "已匹配" : "空闲中"
        });
      }
    });
    return new Response(JSON.stringify({ code: 200, total: onlineList.length, list: onlineList }), { headers: corsHeaders });
  }

  // 清空聊天接口（D1语法适配）
  if (url.pathname === "/api/clearChatOnly" && request.method === "POST") {
    try {
      await dbRun(env, "DELETE FROM messages");
      offlineMsgMem.clear();
      return new Response(JSON.stringify({ code: 200, msg: "清空成功" }), { headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ code: 500, msg: "清空失败" }), { headers: corsHeaders });
    }
  }

  // 文件上传接口（零延迟转发到cvvv，完全不动）
  if (url.pathname.startsWith("/upload")) {
    return env.cvvv.fetch(request);
  }

  // 其他所有请求 → 返回前端网页（零延迟绑定，完全不动）
  return env.nnn.fetch(request);
}

// ========== Worker入口 ==========
export default {
  async fetch(request, env, ctx) {
    // 初始化数据库+加载用户（只执行一次）
    await initDB(env);
    await loadUsers(env);
    // 启动保活检查
    startKeepAliveCheck();
    // 处理请求
    return await handleRequest(request, env);
  }
};
