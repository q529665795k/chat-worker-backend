// 绑定：KV=bbb D1=MY_MMM DO=ChatDO 前端=nnn R2=cvvv
const KEEP_ALIVE_EXPIRE = 24 * 60 * 60 * 1000;
const KEEP_ALIVE_CHECK_INTERVAL = 60 * 1000;
const UNLOGGED_CLEAN_INTERVAL = 180000;
const MATCH_TIMEOUT = 15000;
const HEARTBEAT_INTERVAL = 45000;
const HEARTBEAT_TIMEOUT = 60000;

// ✅ 官方标准顶层导出ChatDO（部署必过）
export class ChatDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.userMap = new Map();
    this.loginMap = new Map();
    this.userMatchTimer = new Map();
