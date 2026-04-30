// ====================== 【单文件终极版｜前端内嵌｜无外部转发】 ======================
// 绑定仅保留：KV(bbb)、D1(MY_MMM)、耐用对象(ChatDO)
// 前端页面直接写在代码里，Worker 自己返回，不再转发外部服务

// -------------------------- 1. 前端页面（直接写死在Worker里） --------------------------
const HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>摸鱼基地 - 聊天</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f141e;color:#fff;font-family:system-ui,-applewich,sans-serif}
.container{max-width:800px;margin:0 auto;padding:20px}
.header{text-align:center;padding:20px 0;border-bottom:1px solid #222}
.btn{padding:12px 24px;border:none;border-radius:8px;background:#ff9500;color:#fff;font-size:16px;cursor:pointer;margin:5px}
.btn-stop{background:#ff3b30}
.chat-box{height:400px;border:1px solid #222;border-radius:8px;padding:15px;margin:20px 0;overflow-y:auto}
.input-box{display:flex;gap:10px}
#msg-input{flex:1;padding:12px;border:1px solid #222;border-radius:8px;background:#1a1f2e;color:#fff}
</style>
</head>
<body>
<div class="container">
<div class="header">
<h1>摸鱼基地</h1>
<p id="status">未连接</p>
</div>
<div>
<button class="btn" id="match-btn">匹配聊天</button>
<button class="btn btn-stop" id="stop-btn">结束聊天</button>
</div>
<div class="chat-box" id="chat"></div>
<div class="input-box">
<input type="text" id="msg-input" placeholder="输入消息...">
<button class="btn" id="send-btn">发送</button>
</div>
</div>

<script>
let ws;
let username = "";
let isMatched = false;

// 连接 WebSocket
function connect(){
const wsUrl = "wss://"+location.host+"/socket";
ws = new WebSocket(wsUrl);

ws.onopen = ()=>{
document.getElementById("status").innerText = "已连接，请登录";
// 模拟登录（测试用，固定账号）
username = "user_"+Math.floor(Math.random()*10000);
ws.send(JSON.stringify({type:"user-online",username:username}));
};

ws.onmessage = (e)=>{
const data = JSON.parse(e.data);
switch(data.type){
case "match-found":
document.getElementById("status").innerText = "匹配成功："+data.data.partnerName;
isMatched = true;
break;
case "partner-leave":
document.getElementById("status").innerText = "对方已离开";
isMatched = false;
break;
case "match-end":
document.getElementById("status").innerText = "聊天结束";
isMatched = false;
break;
case "new-msg":
const chat = document.getElementById("chat");
chat.innerHTML += "<div>"+data.data.fromName+"："+data.data.content+"</div>";
chat.scrollTop = chat.scrollHeight;
break;
}
};

ws.onclose = ()=>{
document.getElementById("status").innerText = "连接断开，重连中...";
setTimeout(connect,2000);
};
}

// 匹配按钮
document.getElementById("match-btn").onclick = ()=>{
ws.send(JSON.stringify({type:"match-chat"}));
document.getElementById("status").innerText = "匹配中...";
};

// 结束聊天
document.getElementById("stop-btn").onclick = ()=>{
ws.send(JSON.stringify({type:"stop-chat"}));
};

// 发送消息
document.getElementById("send-btn").onclick = ()=>{
const input = document.getElementById("msg-input");
const content = input.value.trim();
if(!content || !isMatched)return;
ws.send(JSON.stringify({type:"send-msg",data:{content:content}}));
input.value = "";
};

// 初始化连接
connect();
</script>
</body>
</html>
`;

// -------------------------- 2. Durable Object（聊天核心，类名ChatDO） --------------------------
export class ChatDO {
constructor(state, env) {
this.state = state;
this.env = env;
this.userMap = new Map(); // 在线用户
console.log("DO初始化完成");
}

// 数据库查询
async dbQuery(sql, params = []) {
try {
return await this.env.MY_MMM.prepare(sql).bind(...params).all();
} catch(e){
console.log("数据库失败："+e.message);
return {results:[]};
}
}

// DO入口
async fetch(request, env, ctx) {
const url = new URL(request.url);

// 处理 WebSocket
if(url.pathname === "/socket"){
const upgrade = request.headers.get("Upgrade");
if(upgrade !== "websocket") return new Response("需要WebSocket",{status:400});

const {0:client,1:server} = new WebSocketPair();
server.accept();
const sid = Math.random().toString(36).slice(2);
this.userMap.set(sid,{socket:server,username:"",partner:null,isMatched:false});

// 接收消息
server.addEventListener("message",async (e)=>{
try{
const data = JSON.parse(e.data);
const user = this.userMap.get(sid);

// 登录
if(data.type === "user-online"){
user.username = data.username;
console.log("用户登录："+data.username);
}

// 匹配聊天
if(data.type === "match-chat"){
await this.doMatch(sid,ctx);
}

// 结束聊天
if(data.type === "stop-chat"){
this.stopChat(sid);
}

// 发送消息
if(data.type === "send-msg"){
const target = this.userMap.get(user.partner);
if(target && target.socket){
target.socket.send(JSON.stringify({
type:"new-msg",
data:{fromName:user.username,content:data.data.content}
}));
}
}
}catch(e){
console.log("消息处理失败："+e.message);
}
});

// 连接关闭
server.addEventListener("close",()=>{
this.userMap.delete(sid);
});

return new Response(null,{status:101,webSocket:client});
}

// 根路径返回前端页面
return new Response(HTML,{
headers:{"Content-Type":"text/html;charset=utf-8"}
});
}

// 匹配核心逻辑
async doMatch(sid,ctx){
const user = this.userMap.get(sid);
if(!user.username)return;

// 读取排队池
let wait = await this.env.bbb.get("global_match_wait");
if(wait){
// 有排队用户，直接匹配
const waitUser = JSON.parse(wait);
const target = this.userMap.get(waitUser.sid);
if(target){
// 清空排队池
ctx.waitUntil(this.env.bbb.delete("global_match_wait"));
// 互相绑定
user.partner = waitUser.sid;
target.partner = sid;
user.isMatched = true;
target.isMatched = true;
// 发送匹配成功
user.socket.send(JSON.stringify({type:"match-found",data:{partnerName:target.username}}));
target.socket.send(JSON.stringify({type:"match-found",data:{partnerName:user.username}}));
console.log("真人匹配成功");
return;
}
}

// 没人排队，自己进池
ctx.waitUntil(this.env.bbb.put("global_match_wait",JSON.stringify({sid,username:user.username})));
console.log("进入排队池");

// 15秒超时匹配AI
setTimeout(async ()=>{
const check = await this.env.bbb.get("global_match_wait");
if(check && JSON.parse(check).sid === sid){
ctx.waitUntil(this.env.bbb.delete("global_match_wait"));
// 匹配AI
user.partner = "ai";
user.isMatched = true;
user.socket.send(JSON.stringify({type:"match-found",data:{partnerName:"AI陪伴者"}}));
console.log("超时匹配AI");
}
},15000);
}

// 结束聊天
stopChat(sid){
const user = this.userMap.get(sid);
if(!user)return;
// 清空对方
if(user.partner && user.partner !== "ai"){
const target = this.userMap.get(user.partner);
if(target){
target.partner = null;
target.isMatched = false;
target.socket.send(JSON.stringify({type:"partner-leave"}));
}
}
// 清空自己
user.partner = null;
user.isMatched = false;
user.socket.send(JSON.stringify({type:"match-end"}));
}
}

// -------------------------- 3. Worker入口（极简，只转发给DO） --------------------------
export default {
async fetch(request, env, ctx) {
// 直接调用ChatDO，不再转发任何外部服务
const obj = env.ChatDO.get(env.ChatDO.idFromName("global"),{locationHint:"apac"});
return obj.fetch(request,env,ctx);
}
};
