#!/usr/bin/env node
// 把 storageState 里非公司的域裁掉。
//
// 为什么要有这一步：export-state.sh 导的是整个持久 profile 的 storageState，不分域。
// 手动只传两三个干净 profile 时看不出问题；一旦自动把「含公司 cookie 的 profile」全收
// 进来，个人站的登录态（PayPal / Amazon / Google / Shopify 后台 / 飞书 / TikTok）也会
// 一起进 company.json —— 而 browser-hub 把这份文件注入到每个 isolated 浏览器会话里。
// 所以合并之后必须按白名单裁一刀。
//
// 用法：node filter-company-state.cjs <company.json 的路径>
// 原地改写那个文件，打印裁掉了多少、留下哪些域。

const fs = require("fs");

// 公司自己的域 + 工作上确实要用的第三方。要放行新域就往这里加。
const KEEP = [
  /(^|\.)17u\.cn$/,
  /(^|\.)17usoft\.com$/,
  /(^|\.)elong\.com$/,
  /(^|\.)weixin\.qq\.com$/, // 企业微信文档，公司文档协作在用
];

const out = process.argv[2];
if (!out) {
  console.error("要给 company.json 的路径");
  process.exit(1);
}

const hit = (host) => KEEP.some((re) => re.test(String(host || "").replace(/^\./, "")));

const st = JSON.parse(fs.readFileSync(out, "utf-8"));
const before = (st.cookies || []).length;

st.cookies = (st.cookies || []).filter((c) => hit(c.domain));
st.origins = (st.origins || []).filter((o) => {
  try {
    return hit(new URL(o.origin).hostname);
  } catch {
    return false;
  }
});

fs.writeFileSync(out, JSON.stringify(st, null, 2));

const doms = [...new Set(st.cookies.map((c) => c.domain))].sort();
console.log(`  裁掉 ${before - st.cookies.length} 条非公司 cookie，留下 ${st.cookies.length} 条`);
console.log(`  覆盖的域: ${doms.join(" ")}`);
