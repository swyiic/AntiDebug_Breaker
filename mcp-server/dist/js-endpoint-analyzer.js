import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
const traverse = traverseModule.default || traverseModule;
function memberPath(node) {
    if (!node)
        return null;
    if (node.type === 'Identifier')
        return node.name;
    if (node.type === 'ThisExpression')
        return 'this';
    if (node.type !== 'MemberExpression')
        return null;
    const object = memberPath(node.object);
    const property = node.computed
        ? (node.property?.type === 'StringLiteral' ? node.property.value : null)
        : (node.property?.name || node.property?.value);
    return object && property != null ? `${object}.${property}` : null;
}
function staticString(node, constants, pageUrl = '') {
    if (!node)
        return null;
    if (node.type === 'StringLiteral')
        return node.value;
    if (node.type === 'NumericLiteral')
        return String(node.value);
    if (node.type === 'Identifier')
        return constants.get(node.name) ?? `{${node.name}}`;
    if (node.type === 'MemberExpression') {
        const path = memberPath(node);
        if (path && constants.has(path))
            return constants.get(path);
        try {
            const page = new URL(pageUrl);
            if (/^(?:window\.)?location\.origin$/.test(path || ''))
                return page.origin;
            if (/^(?:window\.)?location\.host$/.test(path || ''))
                return page.host;
            if (/^(?:window\.)?location\.hostname$/.test(path || ''))
                return page.hostname;
            if (/^(?:window\.)?location\.protocol$/.test(path || ''))
                return page.protocol;
        }
        catch { }
        return path ? `{${path}}` : null;
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
        const left = staticString(node.left, constants, pageUrl);
        const right = staticString(node.right, constants, pageUrl);
        return left != null && right != null ? left + right : null;
    }
    if (node.type === 'LogicalExpression')
        return staticString(node.left, constants, pageUrl) || staticString(node.right, constants, pageUrl);
    if (node.type === 'TemplateLiteral') {
        let value = '';
        node.quasis.forEach((part, index) => {
            value += part.value.cooked || '';
            if (node.expressions[index])
                value += staticString(node.expressions[index], constants, pageUrl) ?? '{dynamic}';
        });
        return value;
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && node.callee.property?.name === 'join') {
        const array = node.callee.object;
        const separator = staticString(node.arguments[0], constants, pageUrl) ?? ',';
        if (array?.type === 'ArrayExpression') {
            const values = array.elements.map((element) => staticString(element, constants, pageUrl));
            if (values.every((value) => value != null))
                return values.join(separator);
        }
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
        const property = node.callee.property?.name || node.callee.property?.value;
        const object = memberPath(node.callee.object) || 'runtime';
        if (property === 'getItem') {
            const key = staticString(node.arguments[0], constants, pageUrl) || 'dynamic';
            return `{${object}.${key}}`;
        }
    }
    return null;
}
function isLowInformationPath(value) {
    let pathname = value.replace(/[?#].*$/, '');
    try {
        pathname = new URL(value, 'https://antidebug.invalid/').pathname;
    }
    catch { }
    const segments = pathname.split('/').filter(Boolean).map(segment => {
        try {
            return decodeURIComponent(segment);
        }
        catch {
            return segment;
        }
    });
    if (!segments.length)
        return true;
    if (segments.some(segment => /^(?:api|apis|rest|openapi|gateway|graphql|oauth|auth|login|logout|admin|user|users|upload|download|config|internal|debug|v\d+)$/i.test(segment)))
        return false;
    if (segments.some(segment => /[{}:$]/.test(segment) || /\d{2,}/.test(segment)))
        return false;
    const lexical = segments.filter(segment => !/^v\d+$/i.test(segment));
    return lexical.length > 0 && lexical.every(segment => segment.length <= 2);
}
function looksLikeEndpoint(value) {
    if (isLowInformationPath(value))
        return false;
    return /^(?:https?:)?\/\//i.test(value) || /^\/(?:[\w{}.-]+\/)*[\w{}.-]+/.test(value) || /\/(?:api|rest|gateway|openapi|graphql|v\d+)(?:\/|$)/i.test(value);
}
export function analyzeJavaScriptEndpoints(scripts, pageUrl) {
    const endpoints = [];
    const add = (endpoint) => {
        if (!endpoint.url || !looksLikeEndpoint(endpoint.url))
            return;
        endpoints.push(endpoint);
    };
    for (const script of scripts) {
        if (!script.content)
            continue;
        const content = script.content;
        const source = script.src || `inline:${script.index ?? 0}`;
        let ast;
        try {
            ast = parse(content, {
                sourceType: 'unambiguous',
                errorRecovery: true,
                plugins: ['jsx', 'typescript']
            });
        }
        catch {
            continue;
        }
        const constants = new Map();
        const clientBases = new Map();
        traverse(ast, {
            VariableDeclarator(path) {
                if (path.node.id?.type !== 'Identifier')
                    return;
                const value = staticString(path.node.init, constants, pageUrl);
                if (value != null && value.length < 2000)
                    constants.set(path.node.id.name, value);
                if (path.node.init?.type === 'ObjectExpression') {
                    for (const property of path.node.init.properties || []) {
                        const key = property.key?.name || property.key?.value;
                        const propertyValue = staticString(property.value, constants, pageUrl);
                        if (key && propertyValue != null)
                            constants.set(`${path.node.id.name}.${key}`, propertyValue);
                    }
                }
                const init = path.node.init;
                if (init?.type === 'CallExpression' && init.callee?.type === 'MemberExpression' && (init.callee.property?.name || init.callee.property?.value) === 'create') {
                    const config = init.arguments?.[0];
                    const baseProp = config?.type === 'ObjectExpression' && config.properties.find((property) => (property.key?.name || property.key?.value) === 'baseURL');
                    const base = staticString(baseProp?.value, constants, pageUrl);
                    if (base)
                        clientBases.set(path.node.id.name, base);
                }
            },
            CallExpression(path) {
                const node = path.node;
                let method = 'GET';
                let urlNode = null;
                let evidence = '';
                let configNode = null;
                let bodyNode = null;
                let clientExpression = '';
                if (node.callee?.type === 'Identifier' && node.callee.name === 'fetch') {
                    urlNode = node.arguments[0];
                    evidence = 'fetch()';
                    configNode = node.arguments[1];
                    const methodProp = configNode?.type === 'ObjectExpression' && configNode.properties.find((property) => property.key?.name === 'method');
                    method = staticString(methodProp?.value, constants, pageUrl)?.toUpperCase() || 'GET';
                    bodyNode = configNode?.type === 'ObjectExpression' && configNode.properties.find((property) => ['body', 'data'].includes(property.key?.name))?.value;
                    clientExpression = 'fetch';
                }
                else if (node.callee?.type === 'MemberExpression') {
                    const property = node.callee.property?.name || node.callee.property?.value;
                    const objectName = memberPath(node.callee.object) || node.callee.object?.name;
                    clientExpression = objectName || '';
                    if (property === 'open') {
                        method = staticString(node.arguments[0], constants, pageUrl)?.toUpperCase() || 'GET';
                        urlNode = node.arguments[1];
                        evidence = 'XMLHttpRequest.open()';
                    }
                    else if (['get', 'post', 'put', 'patch', 'delete', 'head'].includes(String(property).toLowerCase())) {
                        method = String(property).toUpperCase();
                        urlNode = node.arguments[0];
                        bodyNode = ['post', 'put', 'patch'].includes(String(property).toLowerCase()) ? node.arguments[1] : null;
                        configNode = node.arguments[['post', 'put', 'patch'].includes(String(property).toLowerCase()) ? 2 : 1];
                        evidence = `${objectName || 'client'}.${property}()`;
                    }
                    else if (property === 'request') {
                        const config = node.arguments[0];
                        if (config?.type === 'ObjectExpression') {
                            const urlProp = config.properties.find((item) => item.key?.name === 'url');
                            const methodProp = config.properties.find((item) => item.key?.name === 'method');
                            urlNode = urlProp?.value;
                            method = staticString(methodProp?.value, constants, pageUrl)?.toUpperCase() || 'GET';
                            evidence = `${objectName || 'client'}.request()`;
                            bodyNode = config.properties.find((item) => ['data', 'body', 'params'].includes(item.key?.name))?.value;
                            configNode = config;
                        }
                    }
                }
                const url = staticString(urlNode, constants, pageUrl);
                if (url) {
                    const start = Number.isInteger(node.start) ? node.start : 0;
                    const end = Number.isInteger(node.end) ? node.end : start;
                    const fields = bodyNode?.type === 'ObjectExpression' ? bodyNode.properties.map((property) => property.key?.name || property.key?.value).filter(Boolean) : [];
                    const headersNode = configNode?.type === 'ObjectExpression' && configNode.properties.find((property) => (property.key?.name || property.key?.value) === 'headers')?.value;
                    const inferredHeaders = headersNode?.type === 'ObjectExpression' ? headersNode.properties.map((property) => property.key?.name || property.key?.value).filter(Boolean) : [];
                    add({
                        method,
                        url,
                        source,
                        line: node.loc?.start?.line,
                        confidence: url.includes('{dynamic}') ? 0.65 : 0.9,
                        evidence,
                        fields,
                        requestShape: fields.map((field) => ({ path: field, type: 'unknown', source: 'Babel AST 请求对象' })),
                        baseCandidates: clientBases.has(clientExpression) ? [clientBases.get(clientExpression)] : [],
                        clientExpression,
                        urlExpression: urlNode?.extra?.raw || url,
                        inferredHeaders,
                        bodyExpression: bodyNode ? (staticString(bodyNode, constants, pageUrl) || bodyNode.type) : '',
                        callExpression: content.slice(start, end).slice(0, 1200),
                        before: content.slice(Math.max(0, start - 240), start).replace(/\s+/g, ' '),
                        after: content.slice(end, end + 240).replace(/\s+/g, ' ')
                    });
                }
            }
        });
    }
    const normalized = new Map();
    for (const endpoint of endpoints) {
        let fullUrl = endpoint.url;
        try {
            fullUrl = new URL(endpoint.url, pageUrl).href;
        }
        catch { }
        const key = `${endpoint.method} ${fullUrl}`;
        const previous = normalized.get(key);
        if (!previous || endpoint.confidence > previous.confidence)
            normalized.set(key, { ...endpoint, fullUrl });
    }
    return [...normalized.values()].sort((a, b) => b.confidence - a.confidence);
}
