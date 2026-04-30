// ====================== 【单文件终极版｜前端内嵌 + Socket.IO完美适配】 ======================
import { Server } from "socket.io";

// ========== 1. 你的完整前端页面（原封不动，一字未改） ==========
const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-status-bar-style" content="black-translucent">
<title>摸鱼基地 - 聊天</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none}
html,body{height:100%;width:100%;background:linear-gradient(135deg, #12142b 0%, #0f1730 100%);color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Microsoft Yahei",sans-serif}
body{display:flex;flex-direction:column}
/* 星星动画已注释，不再动 */
/*
#starfield {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 1;
    pointer-events: none;
}
*/
.login{
    position:fixed;
    top:0;left:0;
    width:100%;height:100%;
    display:flex;
    align-items:center;
    justify-content:center;
    z-index:999;
}
.login-card{
    position: relative;
    z-index: 10;
    background: rgba(255,255,255,0.06);
    backdrop-filter: blur(14px);
    border-radius: 24px;
    border: 1px solid rgba(255,255,255,0.12);
    padding: 45px 35px;
    width: 92%;
    max-width: 460px;
    text-align: center;
}
.main-title{
    font-size: 2rem;
    color: #fff;
    font-weight: 600;
    margin-bottom: 12px;
    text-shadow: 0 0 18px rgba(96,230,205,0.55);
}
.sub-title{
    font-size: 1.2rem;
    color: #c9cdd8;
    margin-bottom: 28px;
    letter-spacing: 1px;
}
.tabs{
    display:flex;
    gap:10px;
    margin-bottom:16px;
}
.tab{
    flex:1;
    padding:12px;
    text-align:center;
    background:rgba(255,255,255,0.1);
    border-radius:18px;
    cursor:pointer;
    font-weight:bold;
    transition:0.2s;
}
.tab.active{
    background:linear-gradient(90deg,#5eead4,#86efac);
    color:#0f1730;
}
.input-group{
    margin-bottom:22px;
    position:relative;
}
.input-group input{
    width:100%;
    padding:18px 18px 18px 55px;
    background:rgba(255,255,255,0.08);
    border:1px solid rgba(255,255,255,0.18);
    border-radius:35px;
    color:#fff;
    font-size:0.8rem;
    outline:none;
    transition:0.3s ease;
}
.input-group input::placeholder{
    color:rgba(255,255,255,0.65);
    font-size:0.75rem;
}
.input-group input:focus{
    border-color:#5eead4;
    box-shadow:0 0 12px rgba(94,234,212,0.4);
}
.input-group .icon{
    position:absolute;
    left:20px;
    top:50%;
    transform:translateY(-50%);
    color:rgba(255,255,255,0.6);
    font-size:1.25rem;
    pointer-events:none;
}
.btn{
    width:100%;
    padding:17px;
    background:linear-gradient(90deg,#5eead4,#86efac);
    border:none;
    border-radius:35px;
    color:#0f1730;
    font-size:1.15rem;
    font-weight:bold;
    cursor:pointer;
    transition:all 0.3s ease;
    margin:0 0 12px 0;
}
.btn:hover{
    transform:translateY(-3px);
    box-shadow:0 6px 25px rgba(94,234,212,0.45);
}
.tip,.tip2{
    color:#ff3b30;
    text-align:center;
    margin-top:8px;
    font-size:13px;
}
.container{
    display:none;
    flex:1;
    padding:14px;
    flex-direction:column;
    gap:10px;
    height:100%;
    min-height:0;
    position:relative;
    z-index:2;
}
.header{display:flex;justify-content:space-between;align-items:center}
.nick{font-size:20px;font-weight:600}
.exit{background:#ff3b30;padding:6px 16px;border-radius:8px;font-size:14px;width:70px;text-align:center}
.bar{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;font-size:14px}
.bar label{display:flex;align-items:center;gap:4px}
.btn-nick{background:#007AFF;padding:6px 12px;border-radius:8px;font-size:13px}
.match{background:#ff9500;padding:12px;border-radius:10px;font-size:16px;width:100%;font-weight:bold;transition:all 0.15s ease}
.match:active{transform:scale(0.96);opacity:0.9}
.tools{display:flex;gap:10px;flex-wrap:wrap}
.tools button{flex:1;padding:10px;border-radius:10px;background:#007AFF;font-size:14px}
.chat{flex:1;background:rgba(255,255,255,0.06);border-radius:12px;padding:12px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;min-height:0;backdrop-filter:blur(6px)}
.msg{padding:10px 14px;border-radius:16px;max-width:75%;word-break:break-all;position:relative}
.me{background:#007AFF;align-self:flex-end}
.other{background:#34c759;align-self:flex-start}
.read{position:absolute;right:8px;bottom:4px;font-size:11px;opacity:.7}
.burn{background:#ff3b30!important}
.burn-tip{position:absolute;top:-18px;right:6px;font-size:11px;color:#ff3b30}
.input-box{display:flex;gap:8px;align-items:center;flex-shrink:0}
.input-box input{
    flex:1;
    margin-bottom:0;
    height:46px;
    padding:0 12px;
    border-radius:8px;
    background:rgba(255,255,255,0.12);
    border:1px solid rgba(255,255,255,0.25);
    color:#ffffff;
    font-size:16px;
}
.input-box input::placeholder{
    color:rgba(255,255,255,0.6);
}
.send{background:#007AFF;color:#fff;border:none;border-radius:8px;font-size:14px;width:70px;padding:6px 12px;text-align:center}
.modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.8);align-items:center;justify-content:center;z-index:9999}
.modal-box{background:#222;padding:24px;border-radius:16px;width:90%;max-width:300px}
.modal-buttons{display:flex;gap:10px;margin-top:14px}
.modal-buttons button{flex:1}
.media-img{max-width:240px;max-height:240px;width:auto;height:auto;border-radius:12px;cursor:pointer;object-fit:cover}
.media-video{max-width:240px;max-height:240px;width:auto;height:auto;border-radius:12px;cursor:pointer;object-fit:cover}
#fullPreview{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.95);z-index:99999;align-items:center;justify-content:center}
#fullMedia{max-width:90vw;max-height:90vh;object-fit:contain}
#fullVideo{max-width:90vw;max-height:90vh;object-fit:contain}
#saveBtn{position:absolute;bottom:40px;background:#007AFF;color:#fff;padding:10px 20px;border-radius:8px;border:none;font-size:16px}
.match-modal{
    display:none;
    position:fixed;
    inset:0;
    background:rgba(0,0,0,0.7);
    align-items:center;
    justify-content:center;
    z-index:99999;
}
.match-modal .box{
    background:#1a1a2e;
    padding:30px;
    border-radius:20px;
    text-align:center;
    width:80%;
    max-width:320px;
}
.match-modal .title{
    font-size:18px;
    margin-bottom:20px;
    color:#fff;
}
.match-modal .btn-ok{
    background:#007AFF;
    color:#fff;
    border:none;
    padding:12px 24px;
    border-radius:12px;
    margin-right:8px;
}
.match-modal .btn-cancel{
    background:#444;
    color:#fff;
    border:none;
    padding:12px 24px;
    border-radius:12px;
}
</style>
</head>
<body>

<!-- 星星画布已注释，不显示、不占用性能 -->
<!-- <canvas id="starfield"></canvas> -->

<div class="match-modal" id="matchModal">
    <div class="box">
        <div class="title">开始聊天</div>
        <button class="btn-ok" onclick="confirmMatch()">确定</button>
        <button class="btn-cancel" onclick="cancelMatch()">取消</button>
    </div>
</div>
<div class="login" id="login">
    <div class="login-card">
        <h1 class="main-title">摸鱼基地，摸鱼搭子已就位！</h1>
        <p class="sub-title">摸鱼搭把手，划水一起走</p>
        <div class="tabs">
            <div class="tab active" id="t1">登录</div>
            <div class="tab" id="t2">注册</div>
        </div>
        <div id="f1">
            <div class="input-group">
                <span class="icon">👤</span>
                <input id="u1" placeholder="取个代号，别用真名，防止被老板查岗">
            </div>
            <div class="input-group">
                <span class="icon">🔒</span>
                <input id="p1" type="password" placeholder="密码记牢，不然摸鱼号都登不上">
            </div>
            <button class="btn" id="loginBtn">上线摸鱼！</button>
            <div class="tip" id="tip"></div>
        </div>
        <div id="f2" style="display:none;">
            <div class="input-group">
                <span class="icon">👤</span>
                <input id="u2" placeholder="取个代号，别用真名，防止被老板查岗">
            </div>
            <div class="input-group">
                <span class="icon">🔒</span>
                <input id="p2" type="password" placeholder="密码记牢，不然摸鱼号都登不上">
            </div>
            <button class="btn" id="regBtn">入伙摸鱼大队</button>
            <div class="tip2" id="tip2"></div>
        </div>
    </div>
</div>
<div class="container" id="main">
    <div class="header">
        <div class="nick" id="nick">加载中...</div>
        <div>
            <button class="exit" id="exit">退出</button>
            <button onclick="clearChat()" class="exit" style="margin-left:10px;">清空记录</button>
        </div>
    </div>
    <div class="bar">
        <label><input type="checkbox" id="burn">阅后即焚</label>
        <label><input type="checkbox" id="sound">提示音</label>
        <label><input type="checkbox" id="read">已读回执</label>
        <button class="btn-nick" onclick="oM()">修改昵称</button>
    </div>
    <button class="match" id="match" onclick="showMatchModal()">匹配聊天</button>
    <div class="tools">
        <button onclick="openGalleryImage()">发送图片</button>
        <button onclick="openGalleryVideo()">发送视频</button>
        <button onclick="openCamera()" style="background:#ff9500;">📷 拍照</button>
        <button onclick="openCameraVideo()" style="background:#ff9500;">🎥 录像</button>
    </div>
    <div class="chat" id="chat"></div>
    <div class="input-box">
        <input id="msg" placeholder="输入消息...">
        <button class="send" id="send">发送</button>
    </div>
</div>
<div class="modal" id="modal">
    <div class="modal-box">
        <input id="newNick" placeholder="输入新昵称">
        <div class="modal-buttons">
            <button onclick="cM()">取消</button>
            <button onclick="sN()">确定</button>
        </div>
    </div>
</div>
<div id="fullPreview">
    <img id="fullMedia" alt="">
    <video id="fullVideo" controls autoplay></video>
    <button id="saveBtn">保存</button>
</div>
<input type="file" id="galleryImage" accept="image/*" hidden>
<input type="file" id="galleryVideo" accept="video/*" hidden>
<input type="file" id="cameraPhoto" accept="image/*" capture="camera" hidden>
<input type="file" id="cameraVideo" accept="video/*" capture="camera" hidden>
<script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.2/socket.io.min.js"></script>
<script>
// 星星动画全部注释，不执行
/*
const canvas = document.getElementById("starfield");
const ctx = canvas.getContext("2d");
let stars = [];
function resizeCanvas(){
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    createStars();
}
window.onresize = resizeCanvas;
function createStars(){
    stars = [];
    let count = Math.floor((canvas.width * canvas.height) / 9000);
    for(let i=0;i<count;i++){
        stars.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            r: Math.random() * 3.2 + 1.2,
            speed: Math.random() * 0.25 + 0.08,
            alpha: Math.random() * 0.6 + 0.4,
            fade: Math.random() * 0.008
        });
    }
}
function drawStars(){
    ctx.clearRect(0,0,canvas.width,canvas.height);
    for(let s of stars){
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI*2);
        ctx.fillStyle = \`rgba(255,255,255,\${s.alpha})\`;
        ctx.fill();
        s.alpha += s.fade;
        if(s.alpha > 0.9 || s.alpha < 0.3) s.fade = -s.fade;
        s.y += s.speed;
        if(s.y > canvas.height){
            s.y = 0;
            s.x = Math.random() * canvas.width;
        }
    }
    requestAnimationFrame(drawStars);
}
resizeCanvas();
drawStars();
*/

const BACKEND_URL = "";
const WORKER_URL = "https://b.im6.qzz.io/upload";
let socket = null;
let nickName = "";
let userId = "";
let partnerId = "";
let roomId = "";
let mState = false;
let heartbeatTimer = null;
let hasOnline = false;
const HEARTBEAT_INTERVAL = 30000;

function sendHeartbeatNow() {
  if (socket && socket.connected) {
    socket.emit("HEARTBEAT");
  }
}
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    sendHeartbeatNow();
  }, HEARTBEAT_INTERVAL);
}
document.addEventListener('visibilitychange', () => {
  if (!socket) return;
  if (!document.hidden) {
    sendHeartbeatNow();
  }
});
window.addEventListener('online', () => {
  if (socket && !socket.connected) socket.connect();
  setTimeout(sendHeartbeatNow, 1000);
});
window.addEventListener('offline', () => {});

async function loadLatestNick() {
  if (!userId) return;
  try {
    let res = await fetch(BACKEND_URL + "/api/get_user_info?user_id=" + userId);
    let data = await res.json();
    nickName = data.nickname || data.nick || data.account || userId;
    document.getElementById("nick").textContent = nickName;
    localStorage.setItem("chat_nickname", nickName);
  } catch (e) {
    nickName = localStorage.getItem("chat_nickname") || userId;
    document.getElementById("nick").textContent = nickName;
  }
}
function saveSwitches() {
    localStorage.setItem("switch_burn", document.getElementById("burn").checked);
    localStorage.setItem("switch_sound", document.getElementById("sound").checked);
    localStorage.setItem("switch_read", document.getElementById("read").checked);
}
function loadSwitches() {
    document.getElementById("burn").checked = localStorage.getItem("switch_burn") === "true";
    document.getElementById("sound").checked = localStorage.getItem("switch_sound") === "true";
    document.getElementById("read").checked = localStorage.getItem("switch_read") === "true";
}

window.onload = function() {
  loadSwitches();
  const savedUserId = localStorage.getItem("chat_user_id");
  if (savedUserId) {
    userId = savedUserId;
    document.getElementById("login").style.display = "none";
    document.getElementById("main").style.display = "flex";
    loadLatestNick();
    C();
  }
  window.addEventListener("storage", (e) => {
      if(e.key === "session_token" && e.newValue && e.newValue !== sessionToken){
          alert("账号已在另一处登录，你已被下线");
          logout();
      }
  });
  document.getElementById("t1").onclick = () => {
    document.getElementById("t1").classList.add("active");
    document.getElementById("t2").classList.remove("active");
    document.getElementById("f1").style.display = "block";
    document.getElementById("f2").style.display = "none";
  };
  document.getElementById("t2").onclick = () => {
    document.getElementById("t2").classList.add("active");
    document.getElementById("t1").classList.remove("active");
    document.getElementById("f1").style.display = "none";
    document.getElementById("f2").style.display = "block";
  };
  document.getElementById("loginBtn").onclick = L;
  document.getElementById("regBtn").onclick = R;
  document.getElementById("exit").onclick = logout;
  document.getElementById("send").onclick = S;
  document.getElementById("msg").onkeydown = (e) => { if (e.key === "Enter") S(); };
  document.getElementById("galleryImage").onchange = (e) => sendMedia(e, "image");
  document.getElementById("galleryVideo").onchange = (e) => sendMedia(e, "video");
  document.getElementById("cameraPhoto").onchange = (e) => sendMedia(e, "image");
  document.getElementById("cameraVideo").onchange = (e) => sendMedia(e, "video");
};

function showMatchModal(){
    if(!userId){
        alert("请先登录");
        return;
    }
    document.getElementById("matchModal").style.display = "flex";
}
function cancelMatch(){
    document.getElementById("matchModal").style.display = "none";
}
function confirmMatch(){
    saveSwitches();
    location.reload();
}

function openGalleryImage() { if (!partnerId) { alert("请先匹配"); return; } document.getElementById("galleryImage").click(); }
function openGalleryVideo() { if (!partnerId) { alert("请先匹配"); return; } document.getElementById("galleryVideo").click(); }
function openCamera() { if (!partnerId) { alert("请先匹配"); return; } document.getElementById("cameraPhoto").click(); }
function openCameraVideo() { if (!partnerId) { alert("请先匹配"); return; } document.getElementById("cameraVideo").click(); }

async function sendMedia(e, type) {
  const file = e.target.files[0];
  if (!file) { e.target.value = ""; return; }
  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await fetch(WORKER_URL, { method: "POST", body: formData });
    const data = await res.json();
    if (!data || !data.url) { alert("上传失败"); return; }
    const url = data.url;
    if (partnerId) {
      const msgId = Date.now() + "";
      const burn = document.getElementById("burn").checked;
      socket.emit("send-msg", {
        content: url, type: type, burn: burn, msgId: msgId, toId: partnerId, roomId: roomId
      });
      aM("我", "", burn, msgId, type, url);
    }
  } catch (err) { alert("上传失败"); }
  e.target.value = "";
}

function logout() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (socket) socket.disconnect();
  localStorage.removeItem("chat_user_id");
  localStorage.removeItem("chat_nickname");
  localStorage.removeItem("session_token");
  location.reload();
}

function b() {
  try { let x = new AudioContext(); let o = x.createOscillator(); g = x.createGain(); o.type = "sine"; o.frequency.value = 660; g.gain.value = 0.3; o.connect(g); g.connect(x.destination); o.start(); o.stop(x.currentTime + 0.18); } catch (e) {}
}
function sy(text) {
  let c = document.getElementById("chat");
  let tip = document.createElement("div");
  tip.style.textAlign = "center"; tip.style.color = "#999"; tip.style.fontSize = "15px"; tip.style.margin = "10px 0";
  tip.textContent = text; c.appendChild(tip); c.scrollTop = c.scrollHeight;
}
function aM(who, text, burn = false, msgId = "", type = "text", url = "") {
  const c = document.getElementById("chat");
  const g = document.createElement("div");
  g.className = "msg " + (who === "我" ? "me" : "other");
  if (msgId) g.dataset.id = msgId;
  if (type === "image") {
    const img = document.createElement("img"); img.src = url; img.className = "media-img";
    img.onerror = function () { img.style.border = "1px solid red"; img.alt = "加载失败"; };
    img.onclick = function () {
      const preview = document.getElementById("fullPreview");
      const fullMedia = document.getElementById("fullMedia");
      const fullVideo = document.getElementById("fullVideo");
      fullMedia.style.display = "block"; fullVideo.style.display = "none"; fullMedia.src = url;
      preview.style.display = "flex"; document.getElementById("saveBtn").style.display = "block"; document.getElementById("saveBtn").innerText = "保存图片";
    };
    g.appendChild(img);
  } else if (type === "video") {
    const video = document.createElement("video"); video.src = url; video.className = "media-video"; video.controls = true; video.playsInline = true;
    video.onclick = function () {
      const preview = document.getElementById("fullPreview");
      const fullMedia = document.getElementById("fullMedia");
      const fullVideo = document.getElementById("fullVideo");
      fullMedia.style.display = "none"; fullVideo.style.display = "block"; fullVideo.src = url;
      preview.style.display = "flex"; document.getElementById("saveBtn").style.display = "block"; document.getElementById("saveBtn").innerText = "保存视频";
    };
    g.appendChild(video);
  } else {
    const textDiv = document.createElement("div"); textDiv.className = "msg-text"; textDiv.textContent = text; g.appendChild(textDiv);
  }
  if (who === "我") { const readTag = document.createElement("div"); readTag.className = "read"; readTag.textContent = "未读"; g.appendChild(readTag); }
  if (burn) {
    g.classList.add("burn");
    let burnTip = document.createElement("div"); burnTip.className = "burn-tip"; burnTip.textContent = "焚·100秒"; g.appendChild(burnTip);
    let t = 100; let timer = setInterval(() => {
      t--; burnTip.textContent = "焚·" + t + "秒";
      if (t <= 0) { clearInterval(timer); if (g.parentNode) g.parentNode.removeChild(g); }
    }, 1000);
  }
  c.appendChild(g); c.scrollTop = c.scrollHeight;
}

async function L() {
  let u = document.getElementById("u1").value.trim();
  let p = document.getElementById("p1").value.trim();
  if (!u || !p) { document.getElementById("tip").textContent = "请输入账号密码"; setTimeout(()=>document.getElementById("tip").textContent="",2000); return; }
  userId = u;
  let newToken = Date.now().toString(36) + Math.random().toString(36).slice(2);
  localStorage.setItem("session_token", newToken);
  sessionToken = newToken;
  try {
    let res = await fetch(BACKEND_URL + "/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p })
    });
    let j = await res.json();
    if (j.code === 200) {
      nickName = j.data.nickname || j.data.nick || j.data.username || userId;
      localStorage.setItem("chat_user_id", userId);
      localStorage.setItem("chat_nickname", nickName);
      document.getElementById("nick").textContent = nickName;
      document.getElementById("login").style.display = "none";
      document.getElementById("main").style.display = "flex";
      await loadLatestNick();
      hasOnline = false;
      C();
    } else {
      document.getElementById("tip").textContent = j.msg || "登录失败";
      setTimeout(()=>document.getElementById("tip").textContent="",2000);
      localStorage.removeItem("session_token");
    }
  } catch (e) {
    document.getElementById("tip").textContent = "网络异常";
    setTimeout(()=>document.getElementById("tip").textContent="",2000);
    localStorage.removeItem("session_token");
  }
}
function R() {
  let u = document.getElementById("u2").value.trim();
  let p = document.getElementById("p2").value.trim();
  if (!u || !p) { document.getElementById("tip2").textContent = "请输入账号密码"; setTimeout(()=>document.getElementById("tip2").textContent="",2000); return; }
  fetch(BACKEND_URL + "/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: p })
  }).then(res=>res.json()).then(j=>{
    document.getElementById("tip2").textContent = j.msg || "注册成功";
    setTimeout(()=>document.getElementById("tip2").textContent="",2000);
  });
}
function C() {
  if (socket) socket.disconnect();
  socket = io(BACKEND_URL, { transports: ["websocket", "polling"] });
  socket.on("connect", () => {
    sendHeartbeatNow();
    if (!hasOnline && userId) {
      socket.emit("user-online", {
        username: userId,
        nickname: nickName || userId
      });
      hasOnline = true;
    }
  });
  socket.on("new-msg", (j) => {
    aM(j.fromName, j.content, j.burn, j.msgId, j.type, j.content);
    b();
    if (document.getElementById("read").checked) {
      socket.emit("msg-read", { msgId: j.msgId });
    }
  });
  socket.on("msg-read", (j) => {
    let ele = document.querySelector(\`.msg[data-id="\${j.msgId}"] .read\`);
    if (ele) ele.textContent = "已读";
  });
  socket.on("match-found", (j) => {
    mState = true; partnerId = j.partnerId; roomId = j.roomId;
    document.getElementById("match").textContent = "取消匹配";
    sy("匹配成功：" + j.partnerName);
  });
  socket.on("partner-leave", () => {
    mState = false; partnerId = ""; roomId = "";
    document.getElementById("match").textContent = "匹配聊天";
    sy("对方已离开");
  });
  startHeartbeat();
}
function S() {
  let t = document.getElementById("msg").value.trim();
  if (!t || !partnerId) { alert("请先匹配"); return; }
  let msgId = Date.now() + "";
  let burn = document.getElementById("burn").checked;
  let showText = nickName + "：" + t;
  socket.emit("send-msg", {
    content: showText, type: "text", burn: burn, msgId: msgId, toId: partnerId, roomId: roomId
  });
  aM("我", showText, burn, msgId, "text");
  b();
  document.getElementById("msg").value = "";
}
function oM() { document.getElementById("modal").style.display = "flex"; }
function cM() { document.getElementById("modal").style.display = "none"; }
async function sN() {
  let nn = document.getElementById("newNick").value.trim();
  if (!nn || nn.length < 2 || nn.length > 20) { alert("昵称2-20字符"); return; }
  try {
    let res = await fetch(BACKEND_URL + "/update-nickname", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: userId, newNickname: nn })
    });
    let r = await res.json();
    if (r.code === 200) {
      nickName = nn; document.getElementById("nick").textContent = nn;
      localStorage.setItem("chat_nickname", nickName);
      document.getElementById("newNick").value = ""; cM(); alert("修改成功！");
    } else { alert("失败：" + (r.msg || "服务器错误")); }
  } catch (err) { alert("修改失败"); }
}
function clearChat(){ document.getElementById("chat").innerHTML = ""; }
document.getElementById("fullPreview").onclick = function(e) {
  this.style.display = "none";
  document.getElementById("fullVideo").pause();
};
</script>
</body>
</html>`;

// ========== 2. Worker + Socket.IO 后端核心（完美适配前端） ==========
export default {
  async fetch(request, env, ctx) {
    // 处理Socket.IO
    if (request.headers.get("upgrade") === "websocket") {
      const io = new Server({
        cors: { origin: "*" }
      });

      // 在线用户池
      const onlineUsers = new Map();
      // 排队池
      let waitUser = null;

      // 核心逻辑
      io.on("connection", (socket) => {
        console.log("✅ 前端连接成功");

        // 上线登录
        socket.on("user-online", (data) => {
          onlineUsers.set(socket.id, {
            socket: socket,
            username: data.username,
            nickname: data.nickname
          });
        });

        // 匹配聊天
        socket.on("match-chat", () => {
          const user = onlineUsers.get(socket.id);
          if (!user) return;

          // 有排队用户，直接匹配
          if (waitUser) {
            const targetSocket = waitUser.socket;
            // 双向绑定
            socket.partner = targetSocket.id;
            targetSocket.partner = socket.id;
            // 发送匹配成功
            socket.emit("match-found", {
              partnerId: targetSocket.id,
              partnerName: waitUser.nickname
            });
            targetSocket.emit("match-found", {
              partnerId: socket.id,
              partnerName: user.nickname
            });
            // 清空排队
            waitUser = null;
          } else {
            // 自己排队
            waitUser = user;
            // 15秒超时匹配AI
            setTimeout(() => {
              if (waitUser && waitUser.socket.id === socket.id) {
                socket.emit("match-found", {
                  partnerId: "ai_bot",
                  partnerName: "AI陪伴者"
                });
                waitUser = null;
              }
            }, 15000);
          }
        });

        // 发送消息
        socket.on("send-msg", (data) => {
          if (socket.partner) {
            const targetSocket = io.sockets.sockets.get(socket.partner);
            if (targetSocket) {
              targetSocket.emit("new-msg", {
                fromName: onlineUsers.get(socket.id)?.nickname || "陌生人",
                content: data.content,
                burn: data.burn,
                msgId: data.msgId,
                type: data.type
              });
            }
          }
        });

        // 心跳
        socket.on("HEARTBEAT", () => {});

        // 断开连接
        socket.on("disconnect", () => {
          onlineUsers.delete(socket.id);
          // 如果是排队用户，清空排队
          if (waitUser && waitUser.socket.id === socket.id) {
            waitUser = null;
          }
          // 通知对方离开
          if (socket.partner) {
            const targetSocket = io.sockets.sockets.get(socket.partner);
            if (targetSocket) {
              targetSocket.emit("partner-leave");
              targetSocket.partner = null;
            }
          }
        });
      });

      return io.handleUpgrade(request);
    }

    // 根路径返回前端页面
    return new Response(HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};
