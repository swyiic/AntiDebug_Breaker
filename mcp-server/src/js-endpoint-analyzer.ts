import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

const traverse: any = (traverseModule as any).default || traverseModule;

type Endpoint = {
  method: string;
  url: string;
  source: string;
  line?: number;
  confidence: number;
  evidence: string;
};

function staticString(node: any, constants: Map<string, string>): string | null {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'NumericLiteral') return String(node.value);
  if (node.type === 'Identifier') return constants.get(node.name) ?? `{${node.name}}`;
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticString(node.left, constants);
    const right = staticString(node.right, constants);
    return left != null && right != null ? left + right : null;
  }
  if (node.type === 'TemplateLiteral') {
    let value = '';
    node.quasis.forEach((part: any, index: number) => {
      value += part.value.cooked || '';
      if (node.expressions[index]) value += staticString(node.expressions[index], constants) ?? '{dynamic}';
    });
    return value;
  }
  if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && node.callee.property?.name === 'join') {
    const array = node.callee.object;
    const separator = staticString(node.arguments[0], constants) ?? ',';
    if (array?.type === 'ArrayExpression') {
      const values = array.elements.map((element: any) => staticString(element, constants));
      if (values.every((value: any) => value != null)) return values.join(separator);
    }
  }
  return null;
}

function isLowInformationPath(value: string): boolean {
  let pathname = value.replace(/[?#].*$/, '');
  try { pathname = new URL(value, 'https://antidebug.invalid/').pathname; } catch {}
  const segments = pathname.split('/').filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  if (!segments.length) return true;
  if (segments.some(segment => /^(?:api|apis|rest|openapi|gateway|graphql|oauth|auth|login|logout|admin|user|users|upload|download|config|internal|debug|v\d+)$/i.test(segment))) return false;
  if (segments.some(segment => /[{}:$]/.test(segment) || /\d{2,}/.test(segment))) return false;
  const lexical = segments.filter(segment => !/^v\d+$/i.test(segment));
  return lexical.length > 0 && lexical.every(segment => segment.length <= 2);
}

function looksLikeEndpoint(value: string): boolean {
  if (isLowInformationPath(value)) return false;
  return /^(?:https?:)?\/\//i.test(value) || /^\/(?:[\w{}.-]+\/)*[\w{}.-]+/.test(value) || /\/(?:api|rest|gateway|openapi|graphql|v\d+)(?:\/|$)/i.test(value);
}

export function analyzeJavaScriptEndpoints(scripts: Array<{ src?: string; content?: string; index?: number }>, pageUrl: string) {
  const endpoints: Endpoint[] = [];
  const add = (endpoint: Endpoint) => {
    if (!endpoint.url || !looksLikeEndpoint(endpoint.url)) return;
    endpoints.push(endpoint);
  };

  for (const script of scripts) {
    if (!script.content) continue;
    const source = script.src || `inline:${script.index ?? 0}`;
    let ast: any;
    try {
      ast = parse(script.content, {
        sourceType: 'unambiguous',
        errorRecovery: true,
        plugins: ['jsx', 'typescript']
      });
    } catch {
      continue;
    }

    const constants = new Map<string, string>();
    traverse(ast, {
      VariableDeclarator(path: any) {
        if (path.node.id?.type !== 'Identifier') return;
        const value = staticString(path.node.init, constants);
        if (value != null && value.length < 2000) constants.set(path.node.id.name, value);
      },
      CallExpression(path: any) {
        const node = path.node;
        let method = 'GET';
        let urlNode: any = null;
        let evidence = '';
        if (node.callee?.type === 'Identifier' && node.callee.name === 'fetch') {
          urlNode = node.arguments[0];
          evidence = 'fetch()';
          const config = node.arguments[1];
          const methodProp = config?.type === 'ObjectExpression' && config.properties.find((property: any) => property.key?.name === 'method');
          method = staticString(methodProp?.value, constants)?.toUpperCase() || 'GET';
        } else if (node.callee?.type === 'MemberExpression') {
          const property = node.callee.property?.name || node.callee.property?.value;
          const objectName = node.callee.object?.name;
          if (property === 'open') {
            method = staticString(node.arguments[0], constants)?.toUpperCase() || 'GET';
            urlNode = node.arguments[1];
            evidence = 'XMLHttpRequest.open()';
          } else if (['get', 'post', 'put', 'patch', 'delete', 'head'].includes(String(property).toLowerCase())) {
            method = String(property).toUpperCase();
            urlNode = node.arguments[0];
            evidence = `${objectName || 'client'}.${property}()`;
          } else if (property === 'request') {
            const config = node.arguments[0];
            if (config?.type === 'ObjectExpression') {
              const urlProp = config.properties.find((item: any) => item.key?.name === 'url');
              const methodProp = config.properties.find((item: any) => item.key?.name === 'method');
              urlNode = urlProp?.value;
              method = staticString(methodProp?.value, constants)?.toUpperCase() || 'GET';
              evidence = `${objectName || 'client'}.request()`;
            }
          }
        }
        const url = staticString(urlNode, constants);
        if (url) add({ method, url, source, line: node.loc?.start?.line, confidence: url.includes('{dynamic}') ? 0.65 : 0.9, evidence });
      }
    });
  }

  const normalized = new Map<string, any>();
  for (const endpoint of endpoints) {
    let fullUrl = endpoint.url;
    try { fullUrl = new URL(endpoint.url, pageUrl).href; } catch {}
    const key = `${endpoint.method} ${fullUrl}`;
    const previous = normalized.get(key);
    if (!previous || endpoint.confidence > previous.confidence) normalized.set(key, { ...endpoint, fullUrl });
  }
  return [...normalized.values()].sort((a, b) => b.confidence - a.confidence);
}
