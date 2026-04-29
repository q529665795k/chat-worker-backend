export default {
  async fetch(request) {
    const target = "https://useavnmd-im.hf.space";
    const req = new Request(request);
    const url = new URL(req.url);
    url.host = new URL(target).host;
    return fetch(url, req);
  }
};
