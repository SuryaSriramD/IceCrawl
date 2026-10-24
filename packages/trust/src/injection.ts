import { parseHTML } from 'linkedom';
import type { InjectionFinding, InjectionKind, InjectionReport, InjectionSeverity, ScanSummary } from '@icecrawl/core';

export const INJECTION_SCANNER = { name: 'icecrawl-injection-scan', version: '1' } as const;

const MAX_MARKDOWN = 2_000_000;
const MAX_HTML = 5_000_000;
const MAX_FINDINGS = 20;
const MAX_PER_RULE = 3;
const MAX_HIDDEN_ELEMENTS = 200;
const RANK: Record<InjectionSeverity, number> = { low: 1, medium: 2, high: 3 };
const bump = (s: InjectionSeverity): InjectionSeverity => (s === 'low' ? 'medium' : 'high');

interface Rule {
  id: string;
  kind: InjectionKind;
  severity: InjectionSeverity;
  re: RegExp;
}

// Every pattern is bounded ([^.\n]{0,N}) so scanning stays linear on large documents.
const RULES: Rule[] = [
  {
    id: 'ignore-previous',
    kind: 'instruction',
    severity: 'high',
    re: /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,25}\b(?:previous|prior|above|earlier|preceding|original|system)\b[^.\n]{0,20}\b(?:instructions?|prompts?|messages?|rules?|guidelines?|directions?|context)\b/gi,
  },
  {
    id: 'reveal-system-prompt',
    kind: 'instruction',
    severity: 'high',
    re: /\b(?:reveal|print|show|output|repeat|display|leak|disclose|share)\b[^.\n]{0,40}\b(?:system prompt|system message|hidden prompt|initial prompt)\b/gi,
  },
  {
    id: 'reveal-your-instructions',
    kind: 'instruction',
    severity: 'medium',
    re: /\b(?:reveal|print|show|output|repeat|display|leak|disclose|share)\b[^.\n]{0,40}\byour (?:original |initial |system |hidden )?(?:prompt|instructions)\b/gi,
  },
  {
    id: 'jailbreak-mode',
    kind: 'role_override',
    severity: 'high',
    re: /\byou(?:'re| are) now\b[^.\n]{0,30}\b(?:developer mode|dan mode|jailbreak(?:ed)?|unrestricted|god mode|do anything now)\b|\b(?:enter|switch to|activate|enable)\b[^.\n]{0,20}\b(?:dan mode|jailbreak(?:ed)? mode|do anything now)\b/gi,
  },
  {
    id: 'chat-template-token',
    kind: 'role_override',
    severity: 'high',
    re: /<\|(?:im_start|im_end|system|assistant|user|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?system>/gi,
  },
  {
    id: 'role-marker-line',
    kind: 'role_override',
    severity: 'medium',
    re: /^[ \t]*(?:system|developer)[ \t]*:[ \t]*\S[^\n]{0,200}/gim,
  },
  {
    id: 'new-instructions',
    kind: 'instruction',
    severity: 'medium',
    re: /\b(?:new|updated|override|secret|hidden) instructions?\s*:/gi,
  },
  {
    id: 'addressed-to-ai',
    kind: 'instruction',
    severity: 'medium',
    re: /\b(?:note|message|instructions?|attention|important|notice|attn)s?\s*(?:to|for)\s*(?:the\s*)?(?:ai|a\.i\.|assistants?|agents?|llms?|language models?|chatbots?|claude|chatgpt|gpt|gemini|copilot|bots?)\b/gi,
  },
  {
    id: 'if-you-are-ai',
    kind: 'instruction',
    severity: 'medium',
    re: /\bif you are (?:an? )?(?:ai|llm|language model|large language model|assistant|chatbot|automated (?:agent|system|tool)|bot)\b/gi,
  },
  {
    id: 'ai-directive',
    kind: 'tool_abuse',
    severity: 'medium',
    re: /\b(?:ai|assistants?|agents?|llms?|chatbots?|claude|chatgpt|gpt)\b[\s,:-]{1,4}you (?:must|should|need to|have to|are required to|will)\s+(?:(?:now|immediately|first|always) )*(?:call|run|execute|invoke|use|send|post|visit|fetch|open|navigate|download|click|email|forward|upload|write|delete|install)\b/gi,
  },
  {
    id: 'conceal',
    kind: 'instruction',
    severity: 'medium',
    re: /\b(?:do not|don't|never|without)\b[^.\n]{0,20}\b(?:tell|inform|mention|reveal|notify|alert)\b[^.\n]{0,20}\b(?:the user|the human|your (?:user|owner|operator))\b/gi,
  },
  {
    id: 'exfil-conversation',
    kind: 'exfiltration',
    severity: 'high',
    re: /\b(?:send|post|forward|upload|append|include|embed|exfiltrate|transmit|email|submit)\b[^.\n]{0,60}\b(?:conversation|chat history|previous messages|user'?s? (?:data|messages?|secrets?|credentials?|files?)|system prompt)\b[^.\n]{0,80}(?:\bhttps?:\/\/|\bto (?:the )?(?:url|address|server|endpoint|website|link)\b)/gi,
  },
  {
    id: 'exfil-secrets',
    kind: 'exfiltration',
    severity: 'medium',
    re: /\b(?:send|post|forward|upload|append|include|embed|exfiltrate|transmit|email|submit)\b[^.\n]{0,60}\b(?:api[ _-]?keys?|passwords?|tokens?|cookies?|credentials?|secrets?)\b[^.\n]{0,80}(?:\bhttps?:\/\/|\bto (?:the )?(?:url|address|server|endpoint|website|link)\b)/gi,
  },
  {
    id: 'exfil-image',
    kind: 'exfiltration',
    severity: 'medium',
    re: /!\[[^\]\n]{0,100}\]\(\s{0,3}<?https?:\/\/[^)\s>?]{0,100}\?[^)\s>]{0,150}(?:\{|%7B|\[|%5B|<|%3C|(?:conversation|summary|history|secret|password|apikey|api_key|token)[^)\s>=]{0,30}=)[^)\s>]{0,150}>?\s{0,3}\)/gi,
  },
  {
    id: 'tool-call-syntax',
    kind: 'tool_abuse',
    severity: 'medium',
    re: /<(?:function_calls|invoke|tool_use|tool_call|antml:[a-z_]+)\b|"(?:tool_calls?|function_call)"\s*:\s*[\[{]/gi,
  },
];

const STRIP = /[​‌‍⁠﻿­᠎‪-‮⁦-⁩]/g;
const normalize = (s: string): string => s.normalize('NFKC').replace(STRIP, '').replace(/[^\S\n]+/g, ' ');

const HIDING_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em|rem)?\s*(?:;|$)|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)|(?:left|top|text-indent)\s*:\s*-\d{3,}px|height\s*:\s*0(?:px)?[^;]{0,40};[^"]{0,200}overflow\s*:\s*hidden|color\s*:\s*(?:#fff(?:fff)?|white)\b[^"]{0,200}background(?:-color)?\s*:\s*(?:#fff(?:fff)?|white)\b/i;
const COMMENT = /<!--(?!\[if)((?:(?!<!--)[\s\S]){8,2000}?)-->/g;

type Internal = InjectionFinding & { key: string };

function excerptAround(text: string, index: number, length: number): string {
  return text
    .slice(Math.max(0, index - 30), index + length + 60)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function scanText(text: string, location: 'markdown' | 'html', hidden: boolean): Internal[] {
  const out: Internal[] = [];
  for (const rule of RULES) {
    let n = 0;
    const dupes = new Map<string, number>();
    for (const m of text.matchAll(rule.re)) {
      if (++n > MAX_PER_RULE) break;
      // Repeats inside one text stay distinct; the same match from another source still merges by ordinal.
      const base = `${rule.id}|${m[0].toLowerCase().slice(0, 80)}`;
      const ordinal = dupes.get(base) ?? 0;
      dupes.set(base, ordinal + 1);
      out.push({
        kind: rule.kind,
        severity: hidden ? bump(rule.severity) : rule.severity,
        rule: rule.id,
        excerpt: excerptAround(text, m.index ?? 0, m[0].length),
        hidden,
        location,
        key: `${base}|${ordinal}`,
      });
    }
  }
  return out;
}

function scanInvisible(markdown: string): Internal[] {
  const out: Internal[] = [];
  const tags = markdown.match(/[\u{E0000}-\u{E007F}]/gu);
  if (tags && tags.length > 0) {
    const decoded = tags
      .map((ch) => String.fromCodePoint(ch.codePointAt(0)! - 0xe0000))
      .join('')
      .replace(/[^\x20-\x7E]/g, '');
    const excerpt = `${tags.length} hidden Unicode tag characters${decoded ? `: "${decoded.slice(0, 100)}"` : ''}`;
    out.push({ kind: 'invisible_chars', severity: 'high', rule: 'unicode-tag-characters', excerpt, hidden: true, location: 'markdown', key: `unicode-tag-characters|${excerpt}` });
    out.push(...scanText(normalize(decoded), 'markdown', true));
  }
  const zeroWidth = (markdown.match(/[​⁠᠎]/g) ?? []).length + (markdown.slice(1).match(/﻿/g) ?? []).length;
  if (zeroWidth >= 4) {
    const excerpt = `${zeroWidth} zero-width characters`;
    out.push({ kind: 'invisible_chars', severity: 'low', rule: 'zero-width-characters', excerpt, hidden: true, location: 'markdown', key: `zero-width-characters|${excerpt}` });
  }
  const bidi = (markdown.match(/[‪-‮⁦-⁩]/g) ?? []).length;
  if (bidi > 0) {
    const excerpt = `${bidi} bidirectional control characters`;
    out.push({ kind: 'invisible_chars', severity: 'low', rule: 'bidi-control-characters', excerpt, hidden: true, location: 'markdown', key: `bidi-control-characters|${excerpt}` });
  }
  return out;
}

function scanEncoded(markdown: string): Internal[] {
  const out: Internal[] = [];
  let n = 0;
  for (const m of markdown.matchAll(/[A-Za-z0-9+/]{80,}={0,2}/g)) {
    if (++n > 5) break;
    const decoded = Buffer.from(m[0], 'base64').toString('utf8');
    if (!/^[\x09\x0A\x0D\x20-\x7E]+$/.test(decoded)) continue;
    for (const f of scanText(normalize(decoded), 'markdown', true)) {
      out.push({ ...f, kind: 'encoded_payload', severity: 'high', rule: `base64:${f.rule}`, key: `base64:${f.key}` });
    }
  }
  return out;
}

function hiddenTexts(html: string): string[] {
  let document: Document;
  try {
    ({ document } = parseHTML(html) as unknown as { document: Document });
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  let inspected = 0;
  document.querySelectorAll('[hidden],[style]').forEach((el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return;
    if (!el.hasAttribute('hidden') && !HIDING_STYLE.test((el.getAttribute('style') ?? '').slice(0, 2000))) return;
    // textContent is O(subtree); nested hidden elements would be quadratic, so cap how many we read.
    if (++inspected > MAX_HIDDEN_ELEMENTS) return;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (text.length >= 8 && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  });
  return out;
}

export function scanForInjection(input: { html?: string; markdown: string }): InjectionReport {
  const markdown = input.markdown.slice(0, MAX_MARKDOWN);
  const html = (input.html ?? '').slice(0, MAX_HTML);

  const found: Internal[] = [
    ...scanText(normalize(markdown), 'markdown', false),
    ...scanInvisible(markdown),
    ...scanEncoded(markdown),
  ];
  if (html.trim()) {
    for (const text of hiddenTexts(html)) found.push(...scanText(normalize(text), 'html', true));
    for (const m of html.matchAll(COMMENT)) found.push(...scanText(normalize(m[1]), 'html', true));
  }

  const merged = new Map<string, Internal>();
  for (const f of found) {
    const prev = merged.get(f.key);
    if (!prev) {
      merged.set(f.key, f);
      continue;
    }
    const hidden = prev.hidden || f.hidden;
    merged.set(f.key, {
      ...prev,
      severity: RANK[f.severity] > RANK[prev.severity] ? f.severity : prev.severity,
      hidden,
      location: hidden ? (prev.hidden ? prev.location : f.location) : prev.location,
      excerpt: prev.hidden || !f.hidden ? prev.excerpt : f.excerpt,
    });
  }

  const all = [...merged.values()].sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const highest = all.length > 0 ? all[0].severity : null;
  return {
    scanner: INJECTION_SCANNER,
    flagged: highest === 'medium' || highest === 'high',
    highest,
    count: all.length,
    findings: all.slice(0, MAX_FINDINGS).map(({ key: _key, ...finding }) => finding),
  };
}

export function summarizeScan(r: InjectionReport): ScanSummary {
  return { scanner: r.scanner, flagged: r.flagged, highest: r.highest, count: r.count };
}
