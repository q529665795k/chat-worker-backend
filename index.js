// ====================== CF Worker + Durable Object 超级详细日志版（根治所有报错+傻瓜日志） ======================
// 绑定资源：
// env.MY_MMM = D1数据库
// env.bbb = KV（全局排队池）
// env.nnn = 前端网页
// env.cvvv = 文件上传桶
// env.CHAT_DO = Durable Object（绑定下面 ChatDO 类）
// ========== 全局配置常量（完全沿用你的，一丝不动） ==========
const KEEP_ALIVE_EXPIRE = 24 * 60 * 60 * 1000;
const KEEP_ALIVE_CHECK_INTERVAL = 60 * 1000;
const UNLOGGED_CLEAN_INTERVAL = 30000;
const REDIS_EXPIRE = 7200;
const MATCH_TIMEOUT = 15000;
const HEARTBEAT_INTERVAL = 300000;
const HEARTBEAT_TIMEOUT = 3600000;

// ========== Durable Object：唯一全局大脑（所有内存、逻辑全放这里，跨Worker全局共享） ==========
export class ChatDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.userMap = new Map();
    this.loginMap = new Map();
    this.userSessionMap = new Map();
    this.keepAliveMap = new Map();
    this.userMatchTimer = new Map();
    this.roomMem = new Map();
    this.offlineMsgMem = new Map();
    this.usernameToSocket = new Map();
    this.startKeepAliveCheck();
    console.log("🟢【DO初始化成功】全局大脑启动完成！");
  }

  async dbQuery(sql, params = []) {
    try {
      const stmt = this.env.MY_MMM.prepare(sql).bind(...params);
      return await stmt.all();
    } catch (e) {
      console.log(`🔴【数据库查询失败】SQL:${sql} | 错误:${e.message}`);
      throw e;
    }
  }
  async dbRun(sql, params = []) {
    try {
      const stmt = this.env.MY_MMM.prepare(sql).bind(...params);
      return await stmt.run();
    } catch (e) {
      console.log(`🔴【数据库执行失败】SQL:${sql} | 错误:${e.message}`);
      throw e;
    }
  }

  sysLog(tag, msg, data = {}) {
    const t = new Date().toLocaleString('zh-CN');
    let logStr = `[${t}] 【${tag}】 ${msg}`;
    if (Object.keys(data).length > 0) logStr += ' | 详情:' + JSON.stringify(data);
    console.log(logStr);
  }

  async callAI(prompt) {
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
      console.log(`🔴【AI对接失败】错误:${e.message}`);
      return "爸爸～我掉线啦🥺";
    }
  }

  async initDB() {
    try {
      await this.dbRun(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        nickname TEXT,
        nick TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.dbRun(`
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
      await this.dbRun(`
      CREATE TABLE IF NOT EXISTS nickname_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        old_nickname TEXT,
        new_nickname TEXT,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.dbRun(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await this.dbRun(`
      CREATE TABLE IF NOT EXISTS register_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        register_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      this.sysLog('数据库', '✅ D1数据表初始化完成');
    } catch (err) {
      console.log(`🔴【数据库初始化致命错误】错误:${err.message} | 完整堆栈:${err.stack}`);
    }
  }

  async loadUsers() {
    try {
      const res = await this.dbQuery('SELECT username,nickname,password FROM users');
      this.loginMap.clear();
      res.results.forEach(u => {
        this.loginMap.set(u.username, { nickname: u.nickname || u.username, password: u.password });
      });
      this.sysLog('用户', '✅ 用户数据加载完成', { 总数: res.results.length });
    } catch (e) { 
      console.log(`🔴【用户加载失败】错误:${e.message} | 完整堆栈:${e.stack}`);
    }
  }

  createMatchRoom(userA, userB) {
    const roomId = `room_${Date.now()}_${Math.floor(Math.random()*10000)}`;
    this.roomMem.set(roomId, { userA, userB, userALeft: false, userBLeft: false, createTime: Date.now() });
    setTimeout(() => this.roomMem.delete(roomId), REDIS_EXPIRE * 1000);
    return roomId;
  }
  saveOfflineMsg(toUserId, msg) {
    if (!this.offlineMsgMem.has(toUserId)) this.offlineMsgMem.set(toUserId, []);
    this.offlineMsgMem.get(toUserId).push({ ...msg, timestamp: Date.now() });
  }
  pushOfflineMsg(socket, userId) {
    const list = this.offlineMsgMem.get(userId) || [];
    list.forEach(m => socket.send(JSON.stringify({ type: 'new-msg', data: m })));
    this.offlineMsgMem.delete(userId);
  }
  cleanMatchTimer(uid) {
    if (this.userMatchTimer.has(uid)) {
      clearTimeout(this.userMatchTimer.get(uid));
      this.userMatchTimer.delete(uid);
    }
  }
  stopChat(uid, isInitiative = true) {
    const me = this.userMap.get(uid);
    if (!me || !me.partner) return;
    this.cleanMatchTimer(uid);
    if (me.partner !== "ai_bot") {
      const pt = this.userMap.get(me.partner);
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
    this.keepAliveMap.delete(uid);
    if (me.roomId) {
      this.roomMem.delete(me.roomId);
      this.offlineMsgMem.delete(me.username);
      me.roomId = null;
    }
    this.sysLog('聊天', '聊天结束', { 用户: me.username, 主动断开: isInitiative });
  }
  assignAiRobot(sid) {
    const u = this.userMap.get(sid);
    if (!u || !u.socket || u.isMatched) return;
    this.cleanMatchTimer(sid);
    const aiName = "AI陪伴者";
    const aiId = "ai_bot";
    const rid = this.createMatchRoom(u.username, aiName);
    u.partner = aiId;
    u.isMatched = true;
    u.roomId = rid;
    this.keepAliveMap.set(sid, { partnerId: aiId, expireTime: Date.now() + KEEP_ALIVE_EXPIRE });
    u.socket.send(JSON.stringify({ type: 'match-found', data: { partnerId: aiId, partnerName: aiName, selfId: sid, roomId: rid } }));
    this.sysLog('匹配', '✅ 匹配AI成功', { 用户: u.username });
  }

  async globalMatch(env, ctx, sid) {
    const user = this.userMap.get(sid);
    if (!user || !user.username) {
      console.log(`🟡【匹配失败】用户信息异常，sid:${sid}`);
      return;
    }
    let waitRaw = await env.bbb.get("global_match_wait");
    if (waitRaw) {
      const waitUser = JSON.parse(waitRaw);
      const targetSid = waitUser.sid;
      const targetUser = this.userMap.get(targetSid);
      ctx.waitUntil(env.bbb.delete("global_match_wait"));
      this.cleanMatchTimer(sid);
      this.cleanMatchTimer(targetSid);
      user.partner = targetSid;
      targetUser.partner = sid;
      user.isMatched = true;
      targetUser.isMatched = true;
      const rid = this.createMatchRoom(user.username, targetUser.username);
      user.roomId = rid;
      targetUser.roomId = rid;
      const aNick = this.loginMap.get(user.username)?.nickname || user.username;
      const bNick = this.loginMap.get(targetUser.username)?.nickname || targetUser.username;
      user.socket.send(JSON.stringify({
        type: "match-found",
        data: { roomId: rid, partnerId: targetSid, partnerName: bNick }
      }));
      targetUser.socket.send(JSON.stringify({
        type: "match-found",
        data: { roomId: rid, partnerId: sid, partnerName: aNick }
      }));
      this.keepAliveMap.set(sid, { partnerId: targetSid, expireTime: Date.now() + KEEP_ALIVE_EXPIRE });
      this.keepAliveMap.set(targetSid, { partnerId: sid, expireTime: Date.now() + KEEP_ALIVE_EXPIRE });
      this.sysLog('匹配', '✅ 真人匹配成功', { 用户1: user.username, 用户2: targetUser.username });
    } else {
      const waitData = JSON.stringify({ sid: sid, username: user.username });
      ctx.waitUntil(env.bbb.put("global_match_wait", waitData));
      const timer = setTimeout(async () => {
        const w = await env.bbb.get("global_match_wait");
        if (w && JSON.parse(w).sid === sid) {
          ctx.waitUntil(env.bbb.delete("global_match_wait"));
          this.assignAiRobot(sid);
        }
      }, MATCH_TIMEOUT);
      this.userMatchTimer.set(sid, timer);
      this.sysLog('匹配', '🟡 进入排队等待', { 用户: user.username });
    }
  }

  startKeepAliveCheck() {
    setInterval(() => {
      const now = Date.now();
      this.keepAliveMap.forEach((val, uid) => {
        const u = this.userMap.get(uid);
        const pid = val.partnerId;
        if (pid === "ai_bot") return;
        const p = this.userMap.get(pid);
        if (!u || !p || !u.socket || !p.socket || now - u.lastKeepAlive > HEARTBEAT_TIMEOUT) {
          this.keepAliveMap.delete(uid);
          this.keepAliveMap.delete(pid);
          u?.socket?.send(JSON.stringify({ type: 'partner-leave' }));
          p?.socket?.send(JSON.stringify({ type: 'partner-leave' }));
          this.sysLog('保活', '🔴 心跳超时/对方离线，自动断开', { 用户1: u?.username, 用户2: p?.username });
          return;
        }
        if (now > val.expireTime) {
          this.stopChat(uid, false);
          this.stopChat(pid, false);
          this.keepAliveMap.delete(uid);
          this.keepAliveMap.delete(pid);
          this.sysLog('保活', '🔴 保活过期，强制断开', { 用户1: u.username, 用户2: p.username });
          return;
        }
      });
    }, KEEP_ALIVE_CHECK_INTERVAL);
  }
}

// ========== Worker入口【超级详细日志版：外层统一转发，彻底解决env未定义】 ==========
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    console.log(`🟢【外层收到请求】路径:${url.pathname} | 来源:${request.headers.get('origin')}`);

    // ========== 1. 【关键！所有转发逻辑放外层！！！外层才有完整env】 ==========
    if (url.pathname.startsWith("/upload")) {
      console.log(`🟢【外层转发】上传请求，转发到cvvv`);
      return env.cvvv.fetch(request);
    }
    if (url.pathname.startsWith("/api/")) {
      console.log(`🟢【外层转发】API请求，转发到nnn`);
      return env.nnn.fetch(request);
    }

    // ========== 2. 只有聊天/websocket相关，才进入DO ==========
    console.log(`🟢【进入DO】聊天/WebSocket请求，进入全局大脑`);
    const obj = env.CHAT_DO.get(
      env.CHAT_DO.idFromName("global-chat-brain"),
      { locationHint: "apac" }
    );
    return obj.fetch(request, env, ctx);
  }
};

// ========== DO内部fetch函数【纯聊天逻辑+超级详细日志，彻底移除转发】 ==========
ChatDO.prototype.fetch = async function(request, env, ctx) {
    try {
      // ========== 第一步：优先处理跨域 + WebSocket（必须放最最开头） ==========
      const origin = request.headers.get('origin') || "";
      const allowOrigins = [
        "https://www.im6.qzz.io",
        "https://w.im6.qzz.io"
      ];
      const corsHeaders = {
        "Access-Control-Allow-Origin": allowOrigins.includes(origin) ? origin : "",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400"
      };

      // 1. 跨域预检优先处理（只处理一次，移除重复代码）
      if (request.method === "OPTIONS") {
        console.log(`🟢【DO跨域预检】成功放行`);
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      // 2. 关键！！！WebSocket请求直接优先处理，跳过数据库初始化
      const url = new URL(request.url);
      if (url.pathname.startsWith("/socket.io")) {
        console.log(`🟢【DO WebSocket】收到连接请求，开始握手`);
        const upgradeHeader = request.headers.get("Upgrade");
        if (!upgradeHeader || upgradeHeader !== "websocket") {
          console.log(`🔴【DO WebSocket】握手失败，不是WebSocket请求`);
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
        this.userMap.set(sid, user);
        this.sysLog('WebSocket', '✅ 客户端连接成功', { 连接ID: sid });

        const heartBeatTimer = setInterval(() => {
          server.send(JSON.stringify({ type: 'ping' }));
        }, 45000);

        const unloginTimer = setInterval(() => {
          if (!user.username || !this.loginMap.has(user.username) || this.userSessionMap.get(user.username) !== sid) {
            console.log(`🟡【WebSocket】用户未登录超时，关闭连接:${sid}`);
            server.close();
            this.userMap.delete(sid);
            clearInterval(unloginTimer);
            clearInterval(heartBeatTimer);
          }
        }, UNLOGGED_CLEAN_INTERVAL);

        server.addEventListener("message", async (event) => {
          try {
            const data = JSON.parse(event.data);
            console.log(`🟢【WebSocket消息】${sid}收到:${data.type}`);
            if (data.type === "ping") {
              server.send(JSON.stringify({ type: "pong" }));
              return;
            }
            if (data.type === "user-online") {
              const { username } = data;
              if (!username || !this.loginMap.has(username)) return;
              user.username = username;
              this.userSessionMap.set(username, sid);
              this.usernameToSocket.set(username, server);
              ctx.waitUntil(env.bbb.put(`user_${username}`, sid));
              this.sysLog('用户上线', '✅ 用户上线成功', { 用户名: username });
              return;
            }
            if (data.type === "match-chat") {
              if (!user.username) return;
              if (user.isMatched) this.stopChat(sid, false);
              this.cleanMatchTimer(sid);
              await this.globalMatch(env, ctx, sid);
              return;
            }
            if (data.type === "stop-chat") {
              this.cleanMatchTimer(sid);
              this.stopChat(sid, true);
              const waitRaw = await env.bbb.get("global_match_wait");
              if (waitRaw && JSON.parse(waitRaw).sid === sid) {
                ctx.waitUntil(env.bbb.delete("global_match_wait"));
              }
              return;
            }
            if (data.type === "HEARTBEAT") {
              if (!user.username) return;
              user.lastKeepAlive = Date.now();
              user.lastActive = Date.now();
              server.send(JSON.stringify({ type: 'HEARTBEAT-ACK' }));
              return;
            }
            if (data.type === "clear-chat") {
              if (user.username) await this.dbRun("DELETE FROM messages WHERE sender=? OR receiver=?", [user.username, user.username]);
              server.send(JSON.stringify({ type: 'clear-chat-record' }));
              return;
            }
            if (data.type === "send-msg") {
              if (!user.username || !user.isMatched || !user.partner) return;
              const to = this.userMap.get(user.partner);
              const fromNick = this.loginMap.get(user.username)?.nickname || user.username;
              
              if (user.partner === 'ai_bot' && data.data.type === 'text') {
                const reply = await this.callAI(data.data.content);
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
              
              if (to && to.socket) {
                await this.dbRun("INSERT INTO messages (sender,receiver,content,msg_type) VALUES (?,?,?,?)", [
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
            if (data.type === "msg-read") {
              const p = this.userMap.get(user.partner);
              if (p && p.socket) {
                p.socket.send(JSON.stringify({ type: 'msg-read', data: { msgId: data.data.msgId } }));
              }
              return;
            }
          } catch (err) {
            console.log(`🔴【WebSocket消息处理失败】错误:${err.message} | 堆栈:${err.stack}`);
          }
        });

        server.addEventListener("close", async () => {
          this.cleanMatchTimer(sid);
          const waitRaw = await env.bbb.get("global_match_wait");
          if (waitRaw && JSON.parse(waitRaw).sid === sid) {
            ctx.waitUntil(env.bbb.delete("global_match_wait"));
          }
          if (user.username) {
            this.userSessionMap.delete(user.username);
            this.usernameToSocket.delete(user.username);
            ctx.waitUntil(env.bbb.delete(`user_${user.username}`));
          }
          this.keepAliveMap.delete(sid);
          this.userMap.delete(sid);
          clearInterval(unloginTimer);
          clearInterval(heartBeatTimer);
          this.sysLog('WebSocket断开', '🔴 客户端断开连接', { 连接ID: sid, 用户名: user.username });
        });

        return new Response(null, { status: 101, webSocket: client });
      }

      // ========== 第二步：普通接口，再执行数据库初始化 ==========
      await this.initDB();
      await this.loadUsers();
      const url2 = new URL(request.url);
      console.log(`🟢【DO普通接口】处理路径:${url2.pathname}`);

      if (url2.pathname === "/") {
        return new Response('😎 DO全局大脑服务稳稳在线～', { headers: corsHeaders });
      }

      if (url2.pathname === "/register" && request.method === "POST") {
        const body = await request.json();
        const { username, password } = body;
        try {
            const existCheck = await this.dbQuery("SELECT 1 FROM users WHERE username = ?", [username]);
            if (existCheck.results.length > 0) {
                return new Response(JSON.stringify({ code: 400, msg: "该账号已被注册，请换一个" }), { headers: corsHeaders });
            }
            await this.dbRun("INSERT INTO users (username,password,nickname,created_at,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)", [username, password, username]);
            this.loginMap.set(username, { nickname: username, password });
            this.sysLog('注册', '✅ 注册成功', { 用户名: username });
            return new Response(JSON.stringify({ code: 200, msg: "注册成功，请登录" }), { headers: corsHeaders });
        } catch (err) {
            console.log(`🔴【注册失败】错误:${err.message} | 堆栈:${err.stack}`);
            return new Response(JSON.stringify({ code: 500, msg: "服务器异常，注册失败" }), { headers: corsHeaders });
        }
      }

      if (url2.pathname === "/login" && request.method === "POST") {
        const body = await request.json();
        const { username, password } = body;
        try {
            const userExist = await this.dbQuery("SELECT 1 FROM users WHERE username = ?", [username]);
            if (userExist.results.length === 0) {
                return new Response(JSON.stringify({ code: 400, msg: "账号不存在，请先注册" }), { headers: corsHeaders });
            }
            const user = await this.dbQuery("SELECT * FROM users WHERE username = ? AND password = ?", [username, password]);
            if (user.results.length === 0) {
              return new Response(JSON.stringify({ code: 400, msg: "密码错误，请重新输入" }), { headers: corsHeaders });
            }
            const userInfo = user.results[0];
            this.loginMap.set(username, { nickname: userInfo.nickname || username, password });
            this.sysLog('登录', '✅ 登录成功', { 用户名: username });
            return new Response(JSON.stringify({
              code: 200,
              msg: "登录成功",
              data: { username: userInfo.username, nickname: userInfo.nickname || username }
            }), { headers: corsHeaders });
        } catch (err) {
            console.log(`🔴【登录失败】错误:${err.message} | 堆栈:${err.stack}`);
            return new Response(JSON.stringify({ code: 500, msg: "服务器异常，登录失败" }), { headers: corsHeaders });
        }
      }

      if (url2.pathname === "/update-nickname" && request.method === "POST") {
        const body = await request.json();
        const { username, newNickname } = body;
        try {
          const nickRepeat = await this.dbQuery(`SELECT username FROM users WHERE nickname = ? AND username != ?`, [newNickname, username]);
          if (nickRepeat.results.length > 0) {
            return new Response(JSON.stringify({ code: 400, msg: '昵称已被占用，请换一个' }), { headers: corsHeaders });
          }
          const userInfo = await this.dbQuery(`SELECT nickname FROM users WHERE username = ?`, [username]);
          if (userInfo.results.length === 0) {
            return new Response(JSON.stringify({ code: 400, msg: '用户不存在' }), { headers: corsHeaders });
          }
          const oldNickname = userInfo.results[0].nickname;
          if (oldNickname === newNickname) {
            return new Response(JSON.stringify({ code: 200, msg: '昵称未发生变化' }), { headers: corsHeaders });
          }
          await this.dbRun(`UPDATE users SET nickname = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?`, [newNickname, username]);
          await this.dbRun(`INSERT INTO nickname_logs (username, old_nickname, new_nickname, create_time) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`, [username, oldNickname, newNickname]);
          if (this.loginMap.has(username)) {
            this.loginMap.set(username, { ...this.loginMap.get(username), nickname: newNickname });
          }
          this.sysLog('昵称修改', '✅ 修改成功', { 用户名: username, 旧昵称: oldNickname, 新昵称: newNickname });
          return new Response(JSON.stringify({ code: 200, msg: '昵称修改成功', data: { username, oldNickname, newNickname } }), { headers: corsHeaders });
        } catch (err) {
          console.log(`🔴【昵称修改失败】错误:${err.message} | 堆栈:${err.stack}`);
          return new Response(JSON.stringify({ code: 500, msg: '服务器错误，修改失败' }), { headers: corsHeaders });
        }
      }

      if (url2.pathname === "/api/onlineUser") {
        const onlineList = [];
        this.userMap.forEach(item => {
          if (item.username && this.loginMap.has(item.username)) {
            const info = this.loginMap.get(item.username);
            onlineList.push({
              username: item.username,
              nickname: info.nickname || item.username,
              isMatched: item.isMatched ? "已匹配" : "空闲中"
            });
          }
        });
        return new Response(JSON.stringify({ code: 200, total: onlineList.length, list: onlineList }), { headers: corsHeaders });
      }

      if (url2.pathname === "/api/clearChatOnly" && request.method === "POST") {
        try {
          await this.dbRun("DELETE FROM messages");
          this.offlineMsgMem.clear();
          this.sysLog('清空聊天', '✅ 聊天记录清空成功');
          return new Response(JSON.stringify({ code: 200, msg: "清空成功" }), { headers: corsHeaders });
        } catch (err) {
          console.log(`🔴【清空聊天失败】错误:${err.message} | 堆栈:${err.stack}`);
          return new Response(JSON.stringify({ code: 500, msg: "清空失败" }), { headers: corsHeaders });
        }
      }

      // 兜底404
      return new Response("Not Found", { status: 404, headers: corsHeaders });

    } catch (globalErr) {
      // 全局兜底捕获：任何地方崩了，都会打印完整堆栈
      console.log(`🔴【DO全局致命崩溃】错误:${globalErr.message} | 完整堆栈:${globalErr.stack}`);
      return new Response("服务器内部错误", { status: 500 });
    }
};
