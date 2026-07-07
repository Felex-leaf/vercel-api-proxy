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
 * 优先从请求头 Referer 中解析出真正应该代理到的协议 + 域名；
 * 如果 Referer 解析不出来（见下方说明），再回退读取 Cookie 中记录的
 * 最近一次代理目标作为兜底。解析成功后自动补全前缀 rewrite 到
 * /:protocol/:domain/:originalPath，浏览器地址栏和请求 URL 均保持不变，
 * 再交由 vercel.json 中已有的 rewrites 规则继续代理到真实目标站点。
 *
 * 关于 Referer 兜底 Cookie（__vp_target）：
 * 有些请求（例如 Google 的 gen_204、GetAsyncData 统计打点）由于页面设置了
 * 较严格的 Referrer-Policy（如 origin），浏览器发出的 Referer 会被裁剪成
 * 只剩 origin（如 https://proxy.felex.top/），丢失了路径中的 /https/域名
 * 前缀信息，导致无法从 Referer 还原出目标站点。为此，每次成功访问一个标准
 * 代理页面（/协议/域名/...）时，都会写入一个 Cookie 记录当前代理目标，
 * 后续裸路径请求在 Referer 信息不完整时，可以用这个 Cookie 兜底。
 */

export const config = {
  // 排除 Vercel 内部资源、静态资源根目录、favicon 等，其余全部匹配
  matcher: ['/((?!_next|_vercel|favicon.ico|index.html).*)'],
};

// 已经携带代理前缀的路径，例如 /https/accounts.google.com/xxx、/http/api.openai.com/xxx
// 协议名只包含字母，域名要求形如 xxx.xxx（避免和真实业务路径的第一段冲突误判）
const PROXY_PREFIX_REG = /^\/([a-zA-Z][a-zA-Z0-9+.-]*)\/([^/]+\.[^/]+|localhost(?::\d+)?)(\/|$)/;

const TARGET_COOKIE_NAME = '__vp_target';

export default function middleware(request) {
  const url = new URL(request.url);

  // 根路径直接放行，展示 index.html
  if (url.pathname === '/') {
    return;
  }

  const prefixMatch = url.pathname.match(PROXY_PREFIX_REG);

  // 已经是 /protocol/domain/... 格式的标准代理请求：
  // 通过 rewrite 回自身路径（no-op，请求最终仍会被 vercel.json 中相同的
  // 规则处理，行为不变），借此机会附加 set-cookie 刷新兜底 Cookie，
  // 记录当前代理目标，供后续 Referer 信息不完整的裸路径请求使用。
  if (prefixMatch) {
    const protocol = prefixMatch[1];
    const domain = prefixMatch[2];
    const response = new Response(null, {
      headers: { 'x-middleware-rewrite': url.toString() },
    });
    response.headers.append('set-cookie', buildTargetCookie(protocol, domain));
    return response;
  }

  // 尝试从 Referer 中解析出原始代理目标，例如：
  // Referer: https://proxy.felex.top/https/accounts.google.com/v3/signin/identifier?...
  const target = resolveTargetFromReferer(request, url) || resolveTargetFromCookie(request);
  if (!target) {
    return;
  }

  const { protocol, domain } = target;

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

/**
 * 从 Referer 头中解析出代理目标（协议 + 域名）
 */
function resolveTargetFromReferer(request, url) {
  const referer = request.headers.get('referer');
  if (!referer) {
    return null;
  }

  let refererUrl;
  try {
    refererUrl = new URL(referer);
  } catch (e) {
    return null;
  }

  // referer 必须是当前代理站点自身发出的，否则不处理
  if (refererUrl.host !== url.host) {
    return null;
  }

  const match = refererUrl.pathname.match(PROXY_PREFIX_REG);
  if (!match) {
    return null;
  }

  return { protocol: match[1], domain: match[2] };
}

/**
 * 从兜底 Cookie 中解析出代理目标（协议 + 域名）
 */
function resolveTargetFromCookie(request) {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) {
    return null;
  }

  const cookieValue = cookieHeader
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${TARGET_COOKIE_NAME}=`));

  if (!cookieValue) {
    return null;
  }

  const raw = decodeURIComponent(cookieValue.slice(TARGET_COOKIE_NAME.length + 1));
  const [protocol, domain] = raw.split('|');
  if (!protocol || !domain) {
    return null;
  }

  return { protocol, domain };
}

/**
 * 构造记录当前代理目标的 Cookie。
 * 有效期设置较短（30 分钟），避免用户切换到别的代理目标站点后，
 * 旧的兜底信息长期残留导致误判。
 */
function buildTargetCookie(protocol, domain) {
  const value = encodeURIComponent(`${protocol}|${domain}`);
  return `${TARGET_COOKIE_NAME}=${value}; Path=/; Max-Age=1800; SameSite=Lax`;
}
