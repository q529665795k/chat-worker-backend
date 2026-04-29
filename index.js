export default {
  async fetch(request, env, ctx) {
    const HF_BACKEND = "https://useavnmd-im.hf.space";
    const url = new URL(request.url);
    const targetUrl = new URL(url.pathname + url.search, HF_BACKEND);

    // 关键：保留WebSocket升级头
    const headers = new Headers(request.headers);
    if (request.headers.get("Upgrade")) {
      headers.set("Upgrade", request.headers.get("Upgrade"));
      headers.set("Connection", "Upgrade");
    }

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.body,
      redirect: "follow"
    });

    // 跨域全开放
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Access-Control-Allow-Origin", "*");
    newHeaders.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    newHeaders.set("Access-Control-Allow-Headers", "*");
    newHeaders.set("Access-Control-Allow-Credentials", "true");

    return new Response(response.body, {
      status: response.status,
      headers: newHeaders
    });
  }
};
