'use strict';
// AdCheck: dependency-free Node.js 20+ link-only ad screening.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');
const { URL } = require('node:url');
const PORT = Number(process.env.PORT || 3000);
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
function localAddress(ip) {
  if (net.isIP(ip) === 4) {
    const x = ip.split('.').map(Number);
    return x[0] === 0 || x[0] === 10 || x[0] === 127 || x[0] >= 224 ||
      (x[0] === 169 && x[1] === 254) || (x[0] === 172 && x[1] >= 16 && x[1] <= 31) ||
      (x[0] === 192 && x[1] === 168) || (x[0] === 100 && x[1] >= 64 && x[1] <= 127) ||
      (x[0] === 192 && x[1] === 0) || (x[0] === 198 && (x[1] === 18 || x[1] === 19)) ||
      (x[0] === 192 && x[1] === 0 && x[2] === 2) ||
      (x[0] === 198 && x[1] === 51 && x[2] === 100) ||
      (x[0] === 203 && x[1] === 0 && x[2] === 113);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') ||
    /^fe[89ab]/.test(v) || v.startsWith('::ffff:') || v.startsWith('2001:db8:');
}
async function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('올바른 https:// 또는 http:// 링크를 입력해 주세요.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('웹페이지 주소만 입력할 수 있어요.');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('일반 웹사이트 주소만 분석할 수 있어요.');
  if (u.hostname === 'localhost' || u.hostname.endsWith('.local') || u.hostname.endsWith('.internal')) throw new Error('내부 네트워크 주소는 분석할 수 없어요.');
  const addresses = net.isIP(u.hostname) ? [{address:u.hostname}] : await dns.lookup(u.hostname, {all:true, verbatim:true});
  if (!addresses.length || addresses.some(a => localAddress(a.address))) throw new Error('내부 또는 보호된 네트워크 주소는 분석할 수 없어요.');
  return u;
}
async function loadUrl(input) {
  let current = input, redirectCount = 0;
  while (redirectCount <= 5) {
    const u = await validateUrl(current);
    let res;
    try { res = await fetch(u, {redirect:'manual', signal: AbortSignal.timeout(11000), headers: {'user-agent':'Mozilla/5.0 (compatible; AdCheck/1.0; +public-ad-review)', 'accept':'text/html,application/xhtml+xml'}}); }
    catch { throw new Error('사이트 접속에 실패했어요. 로그인·접근 차단·네트워크 문제일 수 있어요.'); }
    if ([301,302,303,307,308].includes(res.status)) {
      if (!res.headers.get('location')) throw new Error('이동 주소가 없는 단축 링크예요.');
      current = new URL(res.headers.get('location'), u).href;
      redirectCount++; continue;
    }
    if (!res.ok) throw new Error(`사이트가 HTTP ${res.status} 응답을 반환했어요. 광고 내용을 확인할 수 없어요.`);
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/html') && !type.includes('application/xhtml+xml')) throw new Error('이 링크는 웹 문서가 아니에요. 영상·이미지 광고는 현재 자동 분석할 수 없어요.');
    const length = Number(res.headers.get('content-length') || 0);
    if (length > 1800000) throw new Error('페이지 용량이 너무 커서 자동 분석하지 못했어요.');
    const reader = res.body.getReader(); let bytes = 0; const chunks=[];
    try { while (true) { const {done, value} = await reader.read(); if(done) break; bytes+=value.byteLength; if(bytes>1800000) throw new Error('페이지 용량이 너무 커요.'); chunks.push(value); } }
    finally { await reader.cancel().catch(()=>{}); }
    const joined = Buffer.concat(chunks.map(c=>Buffer.from(c)));
    const charset = /charset\s*=\s*["']?([a-z0-9_-]+)/i.exec(type)?.[1] || 'utf-8';
    let html;
    try { html = new TextDecoder(charset).decode(joined); } catch { html = new TextDecoder('utf-8').decode(joined); }
    return {html, finalUrl:u.href};
  }
  throw new Error('링크 이동이 너무 많아 최종 페이지를 확인할 수 없어요.');
}
function entities(s) {
  return s.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_,n)=> {let x = n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):parseInt(n,10); return x>0 && x<=0x10ffff ? String.fromCodePoint(x):' ';})
    .replace(/&(?:nbsp|ensp|emsp);/gi,' ').replace(/&(?:amp);/gi,'&').replace(/&(?:lt);/gi,'<').replace(/&(?:gt);/gi,'>').replace(/&(?:quot);/gi,'"').replace(/&(?:apos|#39);/gi,"'");
}
function extract(html) {
  const metas=[];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const t=m[0], key=/(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(t)?.[1]?.toLowerCase();
    const value=/content\s*=\s*["']([^"']*)["']/i.exec(t)?.[1];
    if (value && ['description','og:description','og:title','twitter:description'].includes(key)) metas.push(entities(value));
  }
  let title=entities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]||'').trim();
  let body=html.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|svg|header|footer|nav)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ')
    .replace(/<(?:br|p|div|li|section|h[1-6])\b[^>]*>/gi,'\n').replace(/<[^>]+>/g,' ');
  body=entities(body).replace(/[\t \r]+/g,' ').replace(/\n\s*\n+/g,'\n').trim();
  const lines=body.split('\n').map(x=>x.trim()).filter(x=>x.length>=8 && x.length<=500);
  const unique=[...new Set(lines)];
  return {title:title.slice(0,150), description:metas.join(' ').slice(0,1000), body:unique.join('\n').slice(0,18000), lineCount:unique.length};
}
const rules = [
  {id:'guarantee',label:'성과를 단정하는 표현',weight:20, re:/(?:100\s*%\s*(?:효과|성공|보장)|반드시\s*(?:성공|효과|개선)|무조건\s*(?:효과|성공|낫|살|빠)|확실히\s*(?:낫|빠|개선)|효과\s*보장)/i},
  {id:'medical',label:'건강·체중 관련 강한 효과 주장',weight:18,re:/(?:암|당뇨|고혈압|비만|탈모)\s*(?:완치|치료)|(?:일주일|하루|3일|7일)\s*(?:만에|안에)?\s*\d+\s*(?:kg|킬로)\s*(?:감량|감소)|먹기만\s*하면\s*(?:살|체중)/i},
  {id:'absolute',label:'절대적·배타적 표현',weight:13,re:/(?:부작용\s*(?:전혀|제로|0|없)|(?:전세계|국내)\s*(?:유일|최초|1위)|단\s*하나의\s*방법|절대\s*실패\s*없)/i},
  {id:'pressure',label:'과도한 구매 압박 표현',weight:9,re:/(?:지금\s*안\s*사면\s*(?:손해|후회)|(?:단\s*오늘|오늘만)\s*(?:특가|마감)|(?:곧|잠시\s*후)\s*품절|마감\s*임박)/i},
  {id:'testimonial',label:'검증되지 않은 후기·권위 강조 가능성',weight:8,re:/(?:의사들이\s*인정|전문가\s*(?:100\s*%|전원)\s*추천|연예인도\s*극찬|수많은\s*후기가\s*증명)/i},
  {id:'money',label:'수익 보장 관련 주장',weight:20,re:/(?:원금\s*보장.*고수익|무조건\s*수익|매일\s*\d+\s*만원\s*(?:보장|벌)|수익률\s*\d+\s*%\s*보장)/i}
];
function analyze(data) {
  const main = [data.title,data.description,data.body].filter(Boolean).join('\n');
  const hasKorean = (main.match(/[가-힣]/g)||[]).length;
  const substantive = data.body.replace(/\s/g,'').length;
  if (hasKorean<40 || substantive<180) return {status:'unavailable',reason:'광고 설명이 충분히 추출되지 않았어요. 상세 이미지, 로그인·스크립트로 표시되는 내용은 읽지 못할 수 있어요.',title:data.title,preview:main.slice(0,330)};
  const found=[];
  for(const r of rules){const match=r.re.exec(main); if(match) found.push({label:r.label,excerpt:match[0].slice(0,70),weight:r.weight});}
  // A heuristic suspicion indicator, not probability. Caps prevent a few sales phrases from creating 85+.
  const weighted=found.reduce((s,x)=>s+x.weight,0);
  let score=Math.min(88,Math.round(weighted*0.88));
  if(found.length===1) score=Math.min(score,24);
  if(found.length===2) score=Math.min(score,48);
  if(found.length===3) score=Math.min(score,65);
  const grade=score>=85?'매우 확실':score>=70?'확실':score>=55?'보통':score>=35?'불확실':'매우 불확실';
  return {status:'ok',score,grade,title:data.title,found,preview:(data.description||data.body).slice(0,330),warning:'규칙 기반 문구 탐지 결과입니다. 실제 허위·과장 여부를 입증하거나 법적 판단을 내리는 것은 아닙니다.'};
}
const server=http.createServer(async(req,res)=>{
  function send(code,obj){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'same-origin'});res.end(JSON.stringify(obj));}
  if(req.method==='GET' && (req.url==='/' || req.url==='/index.html')){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(INDEX);return;}
  if(req.method==='POST' && req.url==='/api/analyze'){
    let data='';
    try { for await(const chunk of req){data+=chunk.toString();if(data.length>12000) throw Error('링크 입력이 너무 길어요.');}
      const parsed=JSON.parse(data);const url=String(parsed.url||'').trim();if(url.length>6000) throw Error('링크가 너무 길어요.');
      const {html,finalUrl}=await loadUrl(url);const extracted=extract(html);send(200,{...analyze(extracted),finalUrl});
    } catch(e) {send(200,{status:'unavailable',reason:e.message||'알 수 없는 오류가 발생했어요.'});}return;
  }
  send(404,{error:'Not found'});
});
server.listen(PORT,()=>console.log(`AdCheck 실행 중: http://localhost:${PORT}`));
