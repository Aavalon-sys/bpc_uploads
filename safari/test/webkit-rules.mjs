// Approximate model of what Safari's declarativeNetRequest accepts, used only
// by the offline tests (the extension itself asks Safari via
// declarativeNetRequest.isRegexSupported at runtime).
//
// Sources: Apple "Blocking content with your Safari web extension", MDN
// browser-compat-data (webextensions/api/declarativeNetRequest.json) and the
// WebKit content-blocker regex subset (no disjunction, no {n,m}, no \d \w \s \b,
// no lookaround / back-references, ^ and $ only at the ends, ASCII only).
// The model is deliberately strict: anything it accepts should be safe.

const atLeast = (v, major, minor = 0) => v[0] > major || (v[0] === major && v[1] >= minor);

const RESOURCE_TYPES = new Set([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
]);

export function webkitRegexProblem(re) {
  if (typeof re !== 'string' || re === '') return 'empty pattern';
  let inClass = false;
  for (let i = 0; i < re.length; i++) {
    const c = re[i];
    if (c.charCodeAt(0) > 0x7f) return 'non-ASCII character';
    if (c === '\\') {
      const n = re[i + 1];
      if (n === undefined) return 'trailing backslash';
      if ('dDwWsS'.includes(n)) return `built-in character class \\${n}`;
      if (!inClass && 'bB'.includes(n)) return 'word boundary';
      if (!inClass && /[1-9]/.test(n)) return 'back-reference';
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      if (re[i + 1] === '^') i++;
      if (re[i + 1] === ']') i++; // literal ] as first class member
      continue;
    }
    if (c === '|') return 'disjunction';
    if (c === '{' && /^\{\d+(,\d*)?\}/.test(re.slice(i))) return 'brace quantifier';
    if (c === '(' && re[i + 1] === '?') {
      const rest = re.slice(i + 2, i + 4);
      if (rest.startsWith('=') || rest.startsWith('!') || rest === '<=' || rest === '<!') return 'lookaround';
    }
    if (c === '^' && i !== 0) return 'misplaced ^';
    if (c === '$' && i !== re.length - 1) return 'misplaced $';
    if ('*+?'.includes(c) && re[i + 1] === '?' && i > 0) return 'non-greedy quantifier';
  }
  if (inClass) return 'unterminated character class';
  try {
    new RegExp(re);
  } catch (e) {
    return 'invalid JavaScript regex';
  }
  return null;
}

export function safariRuleProblems(rule, version = [17, 0]) {
  const problems = [];
  if (!Number.isInteger(rule.id) || rule.id < 1) problems.push('invalid id');
  const action = rule.action || {};
  const condition = rule.condition || {};
  switch (action.type) {
    case 'block':
    case 'allow':
    case 'upgradeScheme':
    case 'allowAllRequests':
      break;
    case 'redirect':
      if (!atLeast(version, 15, 4)) problems.push('redirect needs Safari 15.4');
      break;
    case 'modifyHeaders':
      if (!atLeast(version, 16, 4)) problems.push('modifyHeaders needs Safari 16.4');
      if (action.responseHeaders) problems.push('responseHeaders are not supported');
      if (!action.requestHeaders || !action.requestHeaders.length) problems.push('modifyHeaders without requestHeaders');
      break;
    default:
      problems.push(`unsupported action ${action.type}`);
  }
  const keyMinVersion = {
    urlFilter: [15, 0], regexFilter: [15, 0], isUrlFilterCaseSensitive: [15, 0],
    resourceTypes: [15, 0], excludedResourceTypes: [15, 0], domainType: [15, 0],
    domains: [15, 0], excludedDomains: [15, 0],
    requestDomains: [16, 4], excludedRequestDomains: [16, 4],
    initiatorDomains: [18, 4], excludedInitiatorDomains: [18, 4],
    requestMethods: [26, 0], excludedRequestMethods: [26, 0],
  };
  for (const key of Object.keys(condition)) {
    const min = keyMinVersion[key];
    if (!min) problems.push(`unsupported condition key ${key}`);
    else if (!atLeast(version, ...min)) problems.push(`condition key ${key} needs Safari ${min.join('.')}`);
  }
  if (condition.urlFilter !== undefined && condition.regexFilter !== undefined)
    problems.push('both urlFilter and regexFilter');
  for (const t of condition.resourceTypes || [])
    if (!RESOURCE_TYPES.has(t)) problems.push(`unsupported resource type ${t}`);
  if (condition.regexFilter !== undefined) {
    const p = webkitRegexProblem(condition.regexFilter);
    if (p) problems.push(`regexFilter ${JSON.stringify(condition.regexFilter)}: ${p}`);
  }
  if ((condition.domains || condition.initiatorDomains) && (condition.excludedDomains || condition.excludedInitiatorDomains))
    problems.push('both included and excluded initiator domains');
  return problems;
}
