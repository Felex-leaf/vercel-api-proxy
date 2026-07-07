/**
 * Vercel Routing Middleware
 *
 * 背景：
 * vercel.json 中通过 rewrites 把 /https/:domain/:path* 映射到 https://:domain/:path*
 * 但是被代理页面内部，经常会用【相对路径】发起请求，例如：
 *   页面地址: https://proxy.felex.top/https/accounts.google.com/v3/signin/identifier?...
 *   页面内部发起: fetch('/v3/signin/_/AccountsSignInUi/cspreport')
 * 这类相对路径请求，浏览器会把它解析成相对于当前代理域名的绝对路径：
 *   https://proxy.felex.top/v3/signin/_/AccountsSignInUi/cspreport
 * 从而丢失了原本 /https/accounts.google.com 这个前缀，导致 vercel.json 的 rewrites
 * 规则匹配不到，最终 404。
 *
 * 解决方案：
 * 在 Routing Middleware 中拦截所有【未携带 /协议/域名 前缀】的请求，
 * 从请求头 Referer 中解析出真正应该代理到的协议 + 域名，
 * 自动补全前缀后 rewrite 到 /:protocol/:domain/:originalPath，
 * 浏览器地址栏和请求 URL 均保持不变，再交由 vercel.json 中已有的 rewrites
 * 规则继续代理到真实目标站点。
 */

export const config = {
  // 排除 Vercel 内部资源、静态资源根目录、favicon 等，其余全部匹配
  matcher: ['/((?!_next|_vercel|favicon.ico|index.html).*)'],
};

// 已经携带代理前缀的路径，例如 /https/accounts.google.com/xxx、/http/api.openai.com/xxx
// 协议名只包含字母，域名要求形如 xxx.xxx（避免和真实业务路径的第一段冲突误判）
const PROXY_PREFIX_REG = /^\/([a-zA-Z][a-zA-Z0-9+.-]*)\/([^/]+\.[^/]+|localhost(?::\d+)?)(\/|$)/;

export default function middleware(request) {
  const url = new URL(request.url);

  // 根路径直接放行，展示 index.html
  if (url.pathname === '/') {
    return;
  }

  // 已经是 /protocol/domain/... 格式的标准代理请求，直接放行给 vercel.json 处理
  if (PROXY_PREFIX_REG.test(url.pathname)) {
    return;
  }

  // 从 Referer 中解析出原始代理目标，例如：
  // Referer: https://proxy.felex.top/https/accounts.google.com/v3/signin/identifier?...
  const referer = request.headers.get('referer');
  if (!referer) {
    return;
  }

  let refererUrl;
  try {
    refererUrl = new URL(referer);
  } catch (e) {
    return;
  }

  // referer 必须是当前代理站点自身发出的，否则不处理
  if (refererUrl.host !== url.host) {
    return;
  }

  const match = refererUrl.pathname.match(PROXY_PREFIX_REG);
  if (!match) {
    return;
  }

  const protocol = match[1];
  const domain = match[2];

  // 拼接出真正的目标路径：
  // /v3/signin/_/AccountsSignInUi/cspreport
  // -> /https/accounts.google.com/v3/signin/_/AccountsSignInUi/cspreport
  const newPathname = `/${protocol}/${domain}${url.pathname}`;
  const rewriteUrl = new URL(newPathname + url.search, url.origin);

  // 使用内部 rewrite（不改变浏览器可见的请求 URL），
  // 通过 x-middleware-rewrite 响应头告知 Vercel 平台将请求转发到新路径，
  // 平台再继续应用 vercel.json 中的 rewrites 规则完成最终代理。
  return new Response(null, {
    headers: {
      'x-middleware-rewrite': rewriteUrl.toString(),
    },
  });
}
