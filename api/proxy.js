/**
 * 反向代理 Edge Function
 *
 * 背景：
 * vercel.json 原来的 rewrites 直接把 /https/:domain/:path* 映射到
 * https://:domain/:path*，本质上只是"转发"而不是"代理"——它不会修改
 * 请求头，导致发送到目标站点（如 accounts.google.com）的请求里：
 *   - Host / :authority  仍然是 proxy.felex.top
 *   - Origin             仍然是 https://proxy.felex.top
 *   - Referer            仍然是 https://proxy.felex.top/https/accounts.google.com/...
 * 而很多站点（尤其是 Google）会校验这些请求头，一旦发现域名不符，
 * 就会拒绝请求或返回异常响应。
 *
 * 解决方案：
 * 用一个 Edge Function 作为真正的代理层，自己发起 fetch 请求：
 *   1. vercel.json 中的 rewrites 会把原始路径解析出的协议、域名、真实路径
 *      通过 query 参数（__vpProtocol / __vpDomain / __vpPath）显式传给本函数，
 *      域名是动态的，从请求中实时读取，不写死。参数名加 __vp 前缀是为了避免
 *      和目标站点自身的业务 query 参数（如 url、path 等常见命名）冲突。
 *   2. 转发前，将请求头中的 Host(:authority) / Origin / Referer，
 *      替换成目标域名，让目标站点认为请求是从它自己的域名发出的。
 *   3. 拿到目标站点的响应后，把 Location / Set-Cookie 等涉及域名的响应头
 *      改写回代理路径，其余原样透传给浏览器。
 *
 * 关于 /cdn-cgi/rum：
 * /cdn-cgi/ 是 Cloudflare 在每个接入 Cloudflare 的域名上保留的特殊端点，
 * 完全由 Cloudflare 边缘节点自己处理，不会转发到源站（如 Facebook 后端）。
 * 其中 /cdn-cgi/rum 是 Cloudflare Web Analytics（真实用户性能监控）的数据
 * 上报地址，正常应返回 204。由于代理请求是服务器到服务器发起的（而非真实
 * 用户浏览器直连），Cloudflare 会在边缘层判定来源不合法而返回 404——这类
 * 请求只是页面性能打点，跟业务功能无关，因此直接在代理层短路拦截，
 * 统一返回 204，避免转发一次注定失败的请求、污染日志和 Network 面板。
 */

export const config = {
  runtime: 'edge',
};

// 转发时需要跳过的请求头（内部参数 / 会被 fetch 自动处理 / 会影响代理判定）
const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-for',
  'x-vercel-id',
  'x-vercel-deployment-url',
  'x-vercel-ip-timezone',
  'x-real-ip',
]);

// 透传响应时需要跳过的响应头（长度/编码由运行时重新计算，避免冲突）
const SKIP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

// Cloudflare 的 /cdn-cgi/ 保留端点中，纯统计上报类的路径由边缘节点自己处理，
// 代理转发过去必定失败（服务器到服务器请求会被 Cloudflare 判定来源不合法），
// 直接在代理层短路拦截、原样返回 204，不发起真实转发。
const CDN_CGI_NOOP_PATH_REG = /^\/cdn-cgi\/(rum|beacon)(\/|$)/i;

export default async function handler(request) {
  const url = new URL(request.url);
  const params = url.searchParams;

  const protocol = params.get('__vpProtocol');
  const domain = params.get('__vpDomain');
  const restPath = params.get('__vpPath') || '/';

  if (!protocol || !domain) {
    return new Response('Bad proxy request: missing target', { status: 400 });
  }

  // /cdn-cgi/rum 等 Cloudflare 边缘自处理的性能打点端点，直接短路返回 204
  if (CDN_CGI_NOOP_PATH_REG.test(restPath)) {
    return new Response(null, { status: 204 });
  }

  // 还原出真正发给目标站点的 query，需要去掉两类内部参数：
  //   1. 我们显式在 destination 中拼接的 __vpProtocol / __vpDomain / __vpPath
  //   2. Vercel rewrites 只要 destination 中使用了命名参数（:vpProtocol 等），
  //      就会自动把这些命名参数本身也当作 query 参数追加到目标 URL 上
  //      （即不带 __ 前缀的同名参数），这里一并清理，避免重复/污染业务参数。
  // 其余业务参数原样保留并转发给目标站点。
  ['__vpProtocol', '__vpDomain', '__vpPath', 'vpProtocol', 'vpDomain', 'vpPath'].forEach((key) => params.delete(key));
  const targetSearch = params.toString();

  const proxyOrigin = url.origin; // 代理站点自身 origin，如 https://proxy.felex.top
  const targetOrigin = `${protocol}://${domain}`; // 目标站点 origin，如 https://accounts.google.com
  const targetUrl = `${targetOrigin}${restPath}${targetSearch ? `?${targetSearch}` : ''}`;

  // 构造转发到目标站点的请求头
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (SKIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    headers.set(key, value);
  }

  // Host（HTTP/2 下即 :authority）动态改写为目标域名
  headers.set('host', domain);

  // Origin 动态改写为目标站点
  if (headers.has('origin')) {
    headers.set('origin', targetOrigin);
  }

  // Referer 中如果包含代理前缀 /协议/域名，替换成目标站点自身地址
  const referer = headers.get('referer');
  if (referer) {
    headers.set('referer', rewriteRefererToTarget(referer, proxyOrigin));
  }

  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body;

  let targetResponse;
  try {
    targetResponse = await fetch(targetUrl, {
      method: request.method,
      headers,
      body,
      redirect: 'manual',
    });
  } catch (err) {
    return new Response(`Proxy fetch failed: ${err.message}`, { status: 502 });
  }

  const responseHeaders = new Headers();
  for (const [key, value] of targetResponse.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (SKIP_RESPONSE_HEADERS.has(lowerKey)) {
      continue;
    }
    if (lowerKey === 'location') {
      // 目标站点的重定向地址改写回代理路径，避免暴露真实域名或跳转到代理外部
      responseHeaders.set(key, rewriteLocationToProxy(value, targetOrigin, proxyOrigin, protocol, domain));
      continue;
    }
    responseHeaders.append(key, value);
  }

  return new Response(targetResponse.body, {
    status: targetResponse.status,
    statusText: targetResponse.statusText,
    headers: responseHeaders,
  });
}

/**
 * 将 Referer 改写为目标站点自身的地址
 * 例如：
 *   https://proxy.felex.top/https/accounts.google.com/v3/signin/identifier
 *   -> https://accounts.google.com/v3/signin/identifier
 */
function rewriteRefererToTarget(referer, proxyOrigin) {
  try {
    const refererUrl = new URL(referer);
    if (refererUrl.origin !== proxyOrigin) {
      // 不是代理站点自己发出的 referer（例如外链跳转过来），原样返回
      return referer;
    }
    const match = refererUrl.pathname.match(/^\/([a-zA-Z][a-zA-Z0-9+.-]*)\/([^/]+\.[^/]+|localhost(?::\d+)?)(\/.*)?$/);
    if (!match) {
      return referer;
    }
    const refProtocol = match[1];
    const refDomain = match[2];
    const refRestPath = match[3] || '/';
    return `${refProtocol}://${refDomain}${refRestPath}${refererUrl.search}`;
  } catch (e) {
    return referer;
  }
}

/**
 * 将目标站点返回的 Location 重定向地址改写回代理路径
 * 例如：
 *   https://accounts.google.com/v3/signin/challenge
 *   -> https://proxy.felex.top/https/accounts.google.com/v3/signin/challenge
 */
function rewriteLocationToProxy(location, targetOrigin, proxyOrigin, protocol, domain) {
  try {
    const locationUrl = new URL(location, targetOrigin);
    if (locationUrl.origin === targetOrigin) {
      return `${proxyOrigin}/${protocol}/${domain}${locationUrl.pathname}${locationUrl.search}`;
    }
    // 跳转到了其他域名，同样走代理，保持浏览器停留在代理站点内
    const otherProtocol = locationUrl.protocol.replace(':', '');
    return `${proxyOrigin}/${otherProtocol}/${locationUrl.host}${locationUrl.pathname}${locationUrl.search}`;
  } catch (e) {
    return location;
  }
}
